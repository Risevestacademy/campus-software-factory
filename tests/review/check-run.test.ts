import { describe, expect, test } from "vitest";

import {
  buildCheckRunReport,
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
        ].join("\n\n"),
      },
      expect.objectContaining({ startLine: 13 }),
    ]);
    expect(report.summary).toContain("## Standards");
    expect(report.summary).toContain("## Spec");
  });

  test("fails a missing purpose and tells the author how to fix it", () => {
    const report = buildCheckRunReport(
      { kind: "missing-purpose" },
      { ...context, purpose: null },
    );

    expect(report).toMatchObject({
      conclusion: "failure",
      externalId: "factory-review:v1:missing-purpose:123",
    });
    expect(report.summary).toContain("## Change and measurable outcome");
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
    ["fork", false],
  ] as const)("treats %s as decisive=%s", (outcome, decisive) => {
    expect(isDecisiveOutcome(outcome)).toBe(decisive);
  });
});
