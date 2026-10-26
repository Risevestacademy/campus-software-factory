import { severityRank, type ReviewResult } from "../../src/review/index.ts";
import type { ExpectedReview, SeededDefect } from "./workspace.ts";

export interface Judgement {
  passed: boolean;
  detail: string;
}

export function judge(expected: ExpectedReview, result: ReviewResult): Judgement {
  if (expected.status === "clean") {
    return result.status === "clean"
      ? { passed: true, detail: "silent as expected" }
      : { passed: false, detail: `expected clean, got ${result.status}: ${summarize(result)}` };
  }
  const judgements = expected.defects.map((defect) => judgeDefect(defect, result));
  const misses = judgements.filter((judgement) => !judgement.passed);
  return misses.length === 0
    ? { passed: true, detail: judgements.map((judgement) => judgement.detail).join("; ") }
    : { passed: false, detail: misses.map((miss) => miss.detail).join("; ") };
}

export function findsEveryExpectedDefect(
  expected: ExpectedReview,
  result: ReviewResult,
): boolean {
  return (
    expected.status === "clean" ||
    expected.defects.every((defect) => findingsAt(defect, result).length > 0)
  );
}

function judgeDefect(defect: SeededDefect, result: ReviewResult): Judgement {
  const location = `${defect.path}:${defect.lines.join("-")}`;
  const located = findingsAt(defect, result);
  const [firstLocated] = located;
  if (firstLocated === undefined) {
    return { passed: false, detail: `missed ${location}; got ${summarize(result)}` };
  }
  const severeEnough = located.some(
    (finding) => severityRank[finding.severity] <= severityRank[defect.severity],
  );
  return severeEnough
    ? { passed: true, detail: `found defect at ${location}` }
    : {
        passed: false,
        detail: `found ${firstLocated.path}:${firstLocated.line} but severity ${firstLocated.severity} is below ${defect.severity}`,
      };
}

function findingsAt(defect: SeededDefect, result: ReviewResult) {
  return result.findings.filter(
    (finding) =>
      finding.path === defect.path &&
      finding.line >= defect.lines[0] &&
      finding.line <= defect.lines[1],
  );
}

function summarize(result: ReviewResult): string {
  return result.findings.length === 0
    ? result.status
    : result.findings.map((finding) => `${finding.path}:${finding.line} ${finding.title}`).join("; ");
}
