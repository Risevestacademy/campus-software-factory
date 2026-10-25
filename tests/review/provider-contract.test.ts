import { describe, expect, test } from "vitest";

import {
  findingsCeiling,
  parseReviewResult,
  providerAdapter,
  type ProviderId,
  type ReviewFinding,
  type ReviewResult,
} from "../../src/review/index.js";

const finding: ReviewFinding = {
  axis: "spec",
  severity: "P1",
  confidence: 0.95,
  path: "src/session.ts",
  line: 42,
  title: "Renewal drops presence",
  evidence: "Presence is cleared before renewal completes.",
  failureScenario: "A renewing user is disconnected.",
  requestedChange: "Clear presence only after renewal settles.",
  source: "PR acceptance criterion",
};
const expected: ReviewResult = { status: "findings", findings: [finding] };
const fixtureJson = JSON.stringify(expected);

function claudeExecutionFile(result: Record<string, unknown>): string {
  return JSON.stringify([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "assistant", message: { content: [] } },
    { type: "result", ...result },
  ]);
}

const claudeSuccess = claudeExecutionFile({
  subtype: "success",
  is_error: false,
  structured_output: expected,
});

describe("provider adapters", () => {
  test.each<[ProviderId, string]>([
    ["claude", claudeSuccess],
    ["claude", `\n${claudeSuccess}\n`],
    ["codex", fixtureJson],
    ["codex", `\`\`\`json\n${fixtureJson}\n\`\`\``],
  ])("%s output normalizes to the shared contract", (provider, raw) => {
    expect(parseReviewResult(providerAdapter(provider).outputFrom(raw))).toEqual(
      expected,
    );
  });

  test.each<ProviderId>(["claude", "codex"])(
    "%s keeps empty output invalid",
    (provider) => {
      expect(() =>
        parseReviewResult(providerAdapter(provider).outputFrom("")),
      ).toThrow("Review output must be valid JSON");
    },
  );

  test.each([
    ["an error result", claudeExecutionFile({ subtype: "error_max_turns", structured_output: expected })],
    ["a success flagged as an error", claudeExecutionFile({ subtype: "success", is_error: true, structured_output: expected })],
    ["a result without structured output", claudeExecutionFile({ subtype: "success", is_error: false })],
    ["a file that is not a message list", fixtureJson],
  ])("claude treats %s as invalid output", (_label, executionFile) => {
    expect(() => parseReviewResult(providerAdapter("claude").outputFrom(executionFile))).toThrow(
      "Review output must be valid JSON",
    );
  });

  test("claude reads output larger than Linux's 128 KiB environment string limit", () => {
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
    const executionFile = claudeExecutionFile({
      subtype: "success",
      is_error: false,
      structured_output: { status: "findings", findings },
    });

    const output = providerAdapter("claude").outputFrom(executionFile);

    expect(output.length).toBeGreaterThan(128 * 1024);
    expect(parseReviewResult(output).findings).toHaveLength(findingsCeiling);
  });

  test("codex never extracts JSON from surrounding prose", () => {
    expect(() =>
      parseReviewResult(
        providerAdapter("codex").outputFrom(`Here is my review:\n${fixtureJson}`),
      ),
    ).toThrow("Review output must be valid JSON");
  });
});
