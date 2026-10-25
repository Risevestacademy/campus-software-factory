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

const maxFindings = 3;
const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const minimumConfidence = 0.9;

export function parseReviewResult(source: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error("Review output must be valid JSON", { cause: error });
  }
  const result = requireExactObject(parsed, ["status", "findings"], "review result");
  const status = requireString(result.status, "review status");
  if (status !== "clean" && status !== "findings" && status !== "missing_spec") {
    throw new Error(`Unsupported review status "${status}"`);
  }
  if (!Array.isArray(result.findings)) {
    throw new Error("Review findings must be an array");
  }
  if (result.findings.length > maxFindings) {
    throw new Error(`Review returned more than ${maxFindings} findings`);
  }
  const findings = result.findings.map(parseFinding);
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

function parseFinding(value: unknown, index: number): ReviewFinding {
  const label = `finding ${index}`;
  const finding = requireExactObject(
    value,
    [
      "axis",
      "severity",
      "confidence",
      "path",
      "line",
      "title",
      "evidence",
      "failureScenario",
      "requestedChange",
      "source",
    ],
    label,
  );
  const axis = requireString(finding.axis, `${label} axis`);
  const severity = requireString(finding.severity, `${label} severity`);
  const confidence = requireNumber(finding.confidence, `${label} confidence`);
  const line = requireNumber(finding.line, `${label} line`);
  if (axis !== "spec" && axis !== "standards") {
    throw new Error(`${label} has unsupported axis "${axis}"`);
  }
  if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
    throw new Error(`${label} has unsupported severity "${severity}"`);
  }
  if (confidence < minimumConfidence || confidence > 1) {
    throw new Error(
      `${label} confidence must be at least ${minimumConfidence} and at most 1`,
    );
  }
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} line must be a positive integer`);
  }
  return {
    axis,
    severity,
    confidence,
    path: requireString(finding.path, `${label} path`),
    line,
    title: requireString(finding.title, `${label} title`),
    evidence: requireString(finding.evidence, `${label} evidence`),
    failureScenario: requireString(
      finding.failureScenario,
      `${label} failure scenario`,
    ),
    requestedChange: requireString(
      finding.requestedChange,
      `${label} requested change`,
    ),
    source: requireString(finding.source, `${label} source`),
  };
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const expectedKeys = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${label} has unexpected property "${key}"`);
    }
  }
  for (const key of keys) {
    if (!(key in object)) {
      throw new Error(`${label} is missing property "${key}"`);
    }
  }
  return object;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}
