import { rm } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { buildWorkspace, loadReviewCases } from "../../evals/review/workspace.js";
import { newSideLineRanges } from "../../src/review/index.js";

const cases = loadReviewCases();

describe("review eval cases", () => {
  test.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s changes code and anchors any expected finding inside its own diff",
    async (_name, reviewCase) => {
      const workspace = await buildWorkspace(reviewCase);
      try {
        expect(workspace.changedFiles.length).toBeGreaterThan(0);
        const defects = reviewCase.expect.status === "findings" ? reviewCase.expect.defects : [];
        for (const { path, lines } of defects) {
          const file = workspace.changedFiles.find((entry) => entry.path === path);
          const ranges = newSideLineRanges(file?.patch ?? "");
          expect(
            ranges.some((range) => range.start <= lines[0] && lines[1] <= range.end),
            `${path}:${lines.join("-")} outside ${JSON.stringify(ranges)}`,
          ).toBe(true);
        }
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    },
  );
});
