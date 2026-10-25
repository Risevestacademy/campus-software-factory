import { describe, expect, test } from "vitest";

import { judge } from "../../evals/review/judge.js";
import type { ExpectedReview } from "../../evals/review/workspace.js";
import type { ReviewFinding } from "../../src/review/index.js";

const expected: ExpectedReview = {
  status: "findings",
  path: "src/session.ts",
  lines: [5, 7],
  severity: "P1",
};

const finding: ReviewFinding = {
  axis: "spec",
  severity: "P1",
  confidence: 0.95,
  path: "src/session.ts",
  line: 6,
  title: "Presence drops during renewal",
  evidence: "presence.remove runs before renewToken.",
  failureScenario: "Other users see the renewing user go offline.",
  requestedChange: "Keep presence until renewal settles.",
  source: "PR purpose",
};

describe("judge", () => {
  test("passes a clean case only when the review stays silent", () => {
    expect(judge({ status: "clean" }, { status: "clean", findings: [] }).passed).toBe(true);
    expect(
      judge({ status: "clean" }, { status: "findings", findings: [finding] }).passed,
    ).toBe(false);
  });

  test("passes a seeded defect found in range at the expected severity or higher", () => {
    expect(judge(expected, { status: "findings", findings: [finding] }).passed).toBe(true);
    expect(
      judge(expected, { status: "findings", findings: [{ ...finding, severity: "P0" }] }).passed,
    ).toBe(true);
  });

  test("fails a seeded defect reported below its expected severity", () => {
    expect(
      judge(expected, { status: "findings", findings: [{ ...finding, severity: "P2" }] }),
    ).toEqual({
      passed: false,
      detail: "found src/session.ts:6 but severity P2 is below P1",
    });
  });

  test("fails a finding outside the seeded defect's lines", () => {
    expect(
      judge(expected, { status: "findings", findings: [{ ...finding, line: 9 }] }).passed,
    ).toBe(false);
  });
});
