import { describe, expect, test } from "vitest";

import { reviewOutputFromCli } from "../../evals/review/cli-output.js";
import { parseReviewResult, type ReviewResult } from "../../src/review/index.js";

const review: ReviewResult = { status: "clean", findings: [] };

function cliStdout(result: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "result", session_id: "s", num_turns: 3, ...result })}\n`;
}

describe("reviewOutputFromCli", () => {
  test("reads structured output from the CLI's success result", () => {
    const stdout = cliStdout({ subtype: "success", is_error: false, structured_output: review });

    expect(parseReviewResult(reviewOutputFromCli(stdout))).toEqual(review);
  });

  test("treats a failed CLI result as invalid output, as production does", () => {
    const stdout = cliStdout({ subtype: "error_max_turns", is_error: true });

    expect(() => parseReviewResult(reviewOutputFromCli(stdout))).toThrow(
      "Review output must be valid JSON",
    );
  });
});
