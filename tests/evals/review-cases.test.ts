import { rm } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { buildWorkspace, loadReviewCases } from "../../evals/review/workspace.js";
import { newSideLineRanges } from "../../src/review/index.js";

const cases = loadReviewCases();
// Real git repositories: defect-large-diff took 4.8s on a loaded machine, against Vitest's 5s default.
const workspaceBuildTimeoutMilliseconds = 30_000;

describe("review eval cases", () => {
  test.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s changes code and places each expected defect where its kind claims",
    async (_name, reviewCase) => {
      const workspace = await buildWorkspace(reviewCase);
      try {
        expect(workspace.changedFiles.length).toBeGreaterThan(0);
        const defects = reviewCase.expect.status === "findings" ? reviewCase.expect.defects : [];
        for (const { path, lines, outsideDiff } of defects) {
          const file = workspace.changedFiles.find((entry) => entry.path === path);
          const ranges = newSideLineRanges(file?.patch ?? "");
          const location = `${path}:${lines.join("-")} against ${JSON.stringify(ranges)}`;
          if (outsideDiff) {
            expect(
              ranges.every((range) => lines[1] < range.start || range.end < lines[0]),
              location,
            ).toBe(true);
          } else {
            expect(
              ranges.some((range) => range.start <= lines[0] && lines[1] <= range.end),
              location,
            ).toBe(true);
          }
        }
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    },
    workspaceBuildTimeoutMilliseconds,
  );
});
