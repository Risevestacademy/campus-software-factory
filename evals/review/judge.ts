import type { ReviewFinding, ReviewResult } from "../../src/review/index.ts";
import type { ExpectedReview } from "./workspace.ts";

export interface Judgement {
  passed: boolean;
  detail: string;
}

const severityRank: Readonly<Record<ReviewFinding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

export function judge(expected: ExpectedReview, result: ReviewResult): Judgement {
  if (expected.status === "clean") {
    return result.status === "clean"
      ? { passed: true, detail: "silent as expected" }
      : { passed: false, detail: `expected clean, got ${result.status}: ${summarize(result)}` };
  }
  const located = result.findings.filter(
    (finding) =>
      finding.path === expected.path &&
      finding.line >= expected.lines[0] &&
      finding.line <= expected.lines[1],
  );
  const [firstLocated] = located;
  if (firstLocated === undefined) {
    return {
      passed: false,
      detail: `missed ${expected.path}:${expected.lines.join("-")}; got ${summarize(result)}`,
    };
  }
  const severeEnough = located.some(
    (finding) => severityRank[finding.severity] <= severityRank[expected.severity],
  );
  return severeEnough
    ? { passed: true, detail: `found defect at ${expected.path}:${expected.lines.join("-")}` }
    : {
        passed: false,
        detail: `found ${firstLocated.path}:${firstLocated.line} but severity ${firstLocated.severity} is below ${expected.severity}`,
      };
}

function summarize(result: ReviewResult): string {
  return result.findings.length === 0
    ? result.status
    : result.findings.map((finding) => `${finding.path}:${finding.line} ${finding.title}`).join("; ");
}
