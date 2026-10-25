import { describe, expect, test } from "vitest";

import {
  newSideLineRanges,
  validateFindingLocations,
  type ChangedFile,
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

const sessionPatch = [
  "@@ -10,4 +10,5 @@ export function renew() {",
  " context",
  "+added",
  " context",
  " context",
  " context",
].join("\n");

const files: ChangedFile[] = [
  {
    path: "src/session.ts",
    patch: sessionPatch,
    additions: 1,
    deletions: 0,
  },
];

describe("newSideLineRanges", () => {
  test("reads every hunk and defaults an omitted count to one line", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b", "@@ -20,2 +21,3 @@", " x", "+y", " x"].join(
      "\n",
    );

    expect(newSideLineRanges(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 21, end: 23 },
    ]);
  });

  test("gives a deletion-only hunk no reviewable lines", () => {
    expect(newSideLineRanges(["@@ -3,2 +2,0 @@", "-a", "-b"].join("\n"))).toEqual([]);
  });
});

describe("validateFindingLocations", () => {
  test("accepts a finding inside a changed hunk", () => {
    expect(() => validateFindingLocations([finding], files)).not.toThrow();
  });

  test("rejects a finding on a file the pull request did not change", () => {
    expect(() =>
      validateFindingLocations([{ ...finding, path: "src/other.ts" }], files),
    ).toThrow("finding 0 path src/other.ts is not changed by this pull request");
  });

  test("rejects a finding outside every changed hunk", () => {
    expect(() =>
      validateFindingLocations([{ ...finding, line: 99 }], files),
    ).toThrow("finding 0 line 99 is outside the changed hunks of src/session.ts");
  });

  test("accepts any line of a changed file whose patch GitHub omitted", () => {
    expect(() =>
      validateFindingLocations(
        [{ ...finding, line: 5000 }],
        [
          {
            path: "src/session.ts",
            patch: null,
            additions: 1,
            deletions: 0,
          },
        ],
      ),
    ).not.toThrow();
  });
});
