import { rm } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { buildWorkspace, loadReviewCases } from "../../evals/review/workspace.js";
import { newSideLineRanges } from "../../src/review/index.js";

const cases = loadReviewCases();

describe("review eval cases", () => {
  test("cover both silence and detection", () => {
    expect(cases.filter((entry) => entry.expect.status === "clean").length).toBeGreaterThanOrEqual(2);
    expect(cases.filter((entry) => entry.expect.status === "findings").length).toBeGreaterThanOrEqual(2);
  });

  test("give every seeded defect the severity it must be reported at", () => {
    for (const entry of cases) {
      if (entry.expect.status === "findings") {
        for (const defect of entry.expect.defects) {
          expect(["P0", "P1", "P2"], entry.name).toContain(defect.severity);
        }
      }
    }
  });

  test("include a case with more defects than the former cap of 3", () => {
    expect(
      cases.some(
        (entry) => entry.expect.status === "findings" && entry.expect.defects.length > 3,
      ),
    ).toBe(true);
  });

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
