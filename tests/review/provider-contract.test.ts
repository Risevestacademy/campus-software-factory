import { describe, expect, test } from "vitest";

import {
  parseReviewResult,
  providerAdapter,
  type ProviderId,
  type ReviewResult,
} from "../../src/review/index.js";

const expected: ReviewResult = {
  status: "findings",
  findings: [
    {
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
    },
  ],
};
const fixtureJson = JSON.stringify(expected);

describe("provider adapters", () => {
  test.each<[ProviderId, string]>([
    ["claude", fixtureJson],
    ["claude", `\n${fixtureJson}\n`],
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

  test("codex never extracts JSON from surrounding prose", () => {
    expect(() =>
      parseReviewResult(
        providerAdapter("codex").outputFrom(`Here is my review:\n${fixtureJson}`),
      ),
    ).toThrow("Review output must be valid JSON");
  });
});
