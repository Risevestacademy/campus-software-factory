import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

describe("Claude review composite action wiring", () => {
  test("claims the SHA before Claude and keeps deterministic publication last", async () => {
    const source = await readFile(
      new URL("../../.github/actions/claude-pr-review/action.yml", import.meta.url),
      "utf8",
    );
    const action = parse(source) as {
      runs: { steps: Array<{ id?: string; name?: string; uses?: string }> };
    };
    const steps = action.runs.steps;
    const preflightIndex = steps.findIndex((step) => step.id === "preflight");
    const claimIndex = steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const claudeIndex = steps.findIndex((step) =>
      step.uses?.startsWith("anthropics/claude-code-action@"),
    );
    const publishIndex = steps.findIndex((step) => step.id === "publish");

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeGreaterThan(preflightIndex);
    expect(claudeIndex).toBeGreaterThan(claimIndex);
    expect(publishIndex).toBeGreaterThan(claudeIndex);
    expect(source).not.toContain("<<'NODE'");
  });
});
