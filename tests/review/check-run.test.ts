import { describe, expect, test } from "vitest";

import {
  buildCheckRunReport,
  checkRunSummaryLimit,
  findingsCeiling,
  isDecisiveOutcome,
  parseExternalId,
  type CheckRunContext,
  type ReviewFinding,
} from "../../src/review/index.js";

const finding: ReviewFinding = {
  axis: "spec",
  severity: "P1",
  confidence: 0.95,
  path: "src/session.ts",
  line: 12,
  title: "Renewal drops presence",
  evidence: "Presence is cleared before renewal completes.",
  failureScenario: "A renewing user is disconnected.",
  requestedChange: "Clear presence only after renewal settles.",
  source: "PR acceptance criterion",
};

const context: CheckRunContext = {
  ciRunId: 123,
  mode: "advisory",
  provider: "claude",
  model: "claude-opus-5-5",
  purpose: "Renew sessions without interrupting presence.",
};

describe("buildCheckRunReport", () => {
  test("passes a clean review", () => {
    expect(buildCheckRunReport({ kind: "clean" }, context)).toMatchObject({
      name: "Factory PR Review",
      conclusion: "success",
      externalId: "factory-review:v1:clean:123",
      title: "No blocking findings",
      annotations: [],
    });
  });

  test("fails findings and annotates each changed line", () => {
    const report = buildCheckRunReport(
      {
        kind: "findings",
        findings: [finding, { ...finding, line: 13, axis: "standards" }],
      },
      context,
    );

    expect(report).toMatchObject({
      conclusion: "failure",
      externalId: "factory-review:v1:findings:123",
      title: "2 blocking findings",
    });
    expect(report.annotations).toEqual([
      {
        path: "src/session.ts",
        startLine: 12,
        endLine: 12,
        annotationLevel: "failure",
        title: "P1: Renewal drops presence",
        message: [
          "Presence is cleared before renewal completes.",
          "Failure scenario: A renewing user is disconnected.",
          "Required change: Clear presence only after renewal settles.",
          "Basis: PR acceptance criterion",
        ].join("\n\n"),
      },
      expect.objectContaining({ startLine: 13 }),
    ]);
    expect(report.summary).toContain("## Standards");
    expect(report.summary).toContain("## Spec");
    expect(report.summary).toContain(
      "- **P1** Renewal drops presence (`src/session.ts:12`)",
    );
  });

  test("orders findings most severe first whatever order the reviewer returned", () => {
    const report = buildCheckRunReport(
      {
        kind: "findings",
        findings: [
          { ...finding, severity: "P2", line: 1 },
          { ...finding, severity: "P0", line: 2 },
          { ...finding, severity: "P1", line: 3 },
          { ...finding, severity: "P0", line: 4 },
        ],
      },
      context,
    );

    expect(report.annotations.map((annotation) => annotation.startLine)).toEqual([2, 4, 3, 1]);
    expect(report.summary.indexOf("session.ts:2")).toBeLessThan(
      report.summary.indexOf("session.ts:1`"),
    );
  });

  test("annotates every finding instead of capping at three", () => {
    const findings = Array.from({ length: 5 }, (_, index) => ({ ...finding, line: index + 1 }));

    const report = buildCheckRunReport({ kind: "findings", findings }, context);

    expect(report.title).toBe("5 blocking findings");
    expect(report.annotations).toHaveLength(5);
  });

  test("warns that more findings may exist only at the ceiling", () => {
    const atCeiling = Array.from({ length: findingsCeiling }, (_, index) => ({
      ...finding,
      line: index + 1,
    }));

    const full = buildCheckRunReport({ kind: "findings", findings: atCeiling }, context);
    const belowCeiling = buildCheckRunReport(
      { kind: "findings", findings: atCeiling.slice(1) },
      context,
    );

    expect(findingsCeiling).toBe(50);
    expect(full.summary).toContain("Ceiling reached");
    expect(belowCeiling.summary).not.toContain("Ceiling reached");
  });

  describe("at the largest review the output schema allows", () => {
    const largest: ReviewFinding = {
      ...finding,
      path: "p".repeat(500),
      title: "t".repeat(200),
      evidence: "e".repeat(1000),
      failureScenario: "f".repeat(1000),
      requestedChange: "r".repeat(1000),
      source: "s".repeat(500),
    };
    const findings = Array.from({ length: findingsCeiling }, () => largest);
    const findingLine = `- **P1** ${largest.title} (\`${largest.path}:12\`)`;

    function linesOf(summary: string): number {
      return summary.split("\n").filter((line) => line === findingLine).length;
    }

    test("fits every finding line without shortening a short purpose", () => {
      const report = buildCheckRunReport({ kind: "findings", findings }, context);

      expect(report.summary.length).toBeLessThanOrEqual(checkRunSummaryLimit);
      expect(report.summary).toContain(`**PR purpose:** ${context.purpose}`);
      expect(linesOf(report.summary)).toBe(findingsCeiling);
    });

    test("shortens only an oversized purpose and keeps every finding, the ceiling notice, and the footer", () => {
      const report = buildCheckRunReport(
        { kind: "findings", findings },
        { ...context, purpose: "x".repeat(100_000) },
      );

      expect(report.summary.length).toBe(checkRunSummaryLimit);
      expect(report.summary).toContain("x … (truncated)");
      expect(linesOf(report.summary)).toBe(findingsCeiling);
      expect(report.summary).toContain("Ceiling reached");
      expect(report.summary).toContain("Reviewer: claude / claude-opus-5-5");
      expect(report.annotations).toHaveLength(findingsCeiling);
    });
  });

  test("fails a missing purpose and tells the author how to fix it", () => {
    const report = buildCheckRunReport(
      { kind: "missing-purpose", reason: "absent" },
      { ...context, purpose: null },
    );

    expect(report).toMatchObject({
      conclusion: "failure",
      externalId: "factory-review:v1:missing-purpose:123",
    });
    expect(report.summary).toContain("Add a non-empty `## Change and measurable outcome`");
  });

  test("asks for a sharper purpose when the reviewer found it too vague", () => {
    const report = buildCheckRunReport(
      { kind: "missing-purpose", reason: "too-vague" },
      context,
    );

    expect(report).toMatchObject({
      conclusion: "failure",
      externalId: "factory-review:v1:missing-purpose:123",
    });
    expect(report.summary).toContain("too vague to review against");
    expect(report.summary).not.toContain("Add a non-empty");
  });

  test("fails a technical error and allows a same-SHA rerun", () => {
    const report = buildCheckRunReport(
      { kind: "technical", reason: "provider timed out twice" },
      context,
    );

    expect(report).toMatchObject({
      conclusion: "failure",
      externalId: "factory-review:v1:technical:123",
    });
    expect(report.summary).toContain("provider timed out twice");
    expect(report.summary).toContain("Re-run");
  });

  test("records Codex fallback and Claude refill time in the review summary", () => {
    const report = buildCheckRunReport(
      { kind: "clean" },
      {
        ...context,
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        fallback: {
          primaryProvider: "claude",
          primaryModel: "claude-opus-5-5",
          refillAt: "3:00 PM (Africa/Lagos)",
        },
      },
    );

    expect(report.summary).toContain(
      "Fallback: claude / claude-opus-5-5 reached its usage limit.",
    );
    expect(report.summary).toContain(
      "Claude refill: 3:00 PM (Africa/Lagos). Future reviews will try Claude first.",
    );
    expect(report.summary).toContain("Reviewer: codex / gpt-6.1-sol / medium");
  });

  test("warns when Claude did not report a refill time", () => {
    const report = buildCheckRunReport(
      { kind: "clean" },
      {
        ...context,
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        fallback: {
          primaryProvider: "claude",
          primaryModel: "claude-opus-5-5",
        },
      },
    );

    expect(report.summary).toContain(
      "Claude refill: not reported. Future reviews will try Claude first.",
    );
  });

  test("marks an oversized pull request neutral with its measured limits", () => {
    const report = buildCheckRunReport(
      {
        kind: "too-large",
        changedLines: 401,
        changedFiles: 16,
        maxChangedLines: 400,
        maxChangedFiles: 15,
      },
      { ...context, purpose: null },
    );

    expect(report).toMatchObject({
      conclusion: "neutral",
      externalId: "factory-review:v1:too-large:123",
      title: "Human review only (PR too large)",
    });
    expect(report.summary).toContain("401 lines across 16 files");
    expect(report.summary).toContain("400 changed lines and 15 changed files");
  });

  test("marks fork pull requests neutral for human-only review", () => {
    expect(
      buildCheckRunReport({ kind: "fork" }, { ...context, purpose: null }),
    ).toMatchObject({
      conclusion: "neutral",
      externalId: "factory-review:v1:fork:123",
      title: "Human review only (fork)",
    });
  });

  test.each([
    ["advisory", "Advisory canary: this check does not block merge yet."],
    ["enforced", "Enforced: required before merge into dev and main."],
  ] as const)("states %s mode in the summary", (mode, line) => {
    expect(
      buildCheckRunReport({ kind: "clean" }, { ...context, mode }).summary,
    ).toContain(line);
  });
});

describe("parseExternalId", () => {
  test("round-trips factory ids and ignores foreign ones", () => {
    expect(parseExternalId("factory-review:v1:findings:123")).toEqual({
      outcome: "findings",
      ciRunId: 123,
    });
    expect(parseExternalId("other-app:1")).toBeNull();
    expect(parseExternalId(null)).toBeNull();
  });
});

describe("isDecisiveOutcome", () => {
  test.each([
    ["clean", true],
    ["findings", true],
    ["technical", false],
    ["missing-purpose", false],
    ["pending", false],
    ["too-large", false],
    ["fork", false],
  ] as const)("treats %s as decisive=%s", (outcome, decisive) => {
    expect(isDecisiveOutcome(outcome)).toBe(decisive);
  });
});
