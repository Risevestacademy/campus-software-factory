import { createJsonParser } from "../schema/index.ts";

export type ProviderId = "claude" | "codex";

export interface ReviewFinding {
  axis: "spec" | "standards";
  severity: "P0" | "P1" | "P2";
  confidence: number;
  path: string;
  line: number;
  title: string;
  evidence: string;
  failureScenario: string;
  requestedChange: string;
  source: string;
}

export type ReviewResult =
  | { status: "clean" | "missing_spec"; findings: [] }
  | { status: "findings"; findings: ReviewFinding[] };

export interface ChangedFile {
  path: string;
  patch: string | null;
}

export interface LineRange {
  start: number;
  end: number;
}

interface ReviewOutput {
  status: ReviewResult["status"];
  findings: ReviewFinding[];
}

export const reviewOutputSchemaUrl = new URL(
  "../../policies/schema/review-output.schema.json",
  import.meta.url,
);

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const findingTextFields = [
  "path",
  "title",
  "evidence",
  "failureScenario",
  "requestedChange",
  "source",
] as const;
const validateReviewOutput = createJsonParser<ReviewOutput>(
  reviewOutputSchemaUrl,
  "Review output",
);

export function parseReviewResult(source: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error("Review output must be valid JSON", { cause: error });
  }
  const { status, findings } = validateReviewOutput(parsed);
  findings.forEach(requireVisibleText);
  if (status !== "findings" && findings.length > 0) {
    throw new Error(`Review status "${status}" requires an empty findings array`);
  }
  if (status === "findings" && findings.length === 0) {
    throw new Error('Review status "findings" requires at least one finding');
  }
  return status === "findings"
    ? { status, findings }
    : { status, findings: [] };
}

export function newSideLineRanges(patch: string): LineRange[] {
  return [...patch.matchAll(hunkHeader)].flatMap((match) => {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return count === 0 ? [] : [{ start, end: start + count - 1 }];
  });
}

// Context lines count as changed: a defect introduced by a change often sits
// beside it, and GitHub accepts annotations on any line inside a hunk.
export function validateFindingLocations(
  findings: readonly ReviewFinding[],
  files: readonly ChangedFile[],
): void {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  findings.forEach((finding, index) => {
    const file = filesByPath.get(finding.path);
    if (file === undefined) {
      throw new Error(
        `finding ${index} path ${finding.path} is not changed by this pull request`,
      );
    }
    if (file.patch === null) {
      return;
    }
    const inChangedHunk = newSideLineRanges(file.patch).some(
      (range) => finding.line >= range.start && finding.line <= range.end,
    );
    if (!inChangedHunk) {
      throw new Error(
        `finding ${index} line ${finding.line} is outside the changed hunks of ${finding.path}`,
      );
    }
  });
}

// The schema's minLength admits whitespace, which would publish an empty annotation.
function requireVisibleText(finding: ReviewFinding, index: number): void {
  for (const field of findingTextFields) {
    if (finding[field].trim().length === 0) {
      throw new Error(`finding ${index} ${field} must not be blank`);
    }
  }
}
