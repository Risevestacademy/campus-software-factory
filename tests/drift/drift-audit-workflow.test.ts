import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

interface Step {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

const workflow = parse(
  await readFile(new URL("../../.github/workflows/drift-audit.yml", import.meta.url), "utf8"),
) as { jobs: { audit: { steps: Step[] } } };
const steps = workflow.jobs.audit.steps;

describe("drift audit workflow", () => {
  test("audits the review gate with the audit token", () => {
    const gate = steps.find((step) => step.id === "review_gate");

    expect(gate?.run).toContain("pnpm drift:review-gate");
    expect(gate?.env?.FACTORY_AUDIT_TOKEN).toBe("${{ secrets.FACTORY_AUDIT_TOKEN }}");
  });

  test("reports and fails on ruleset drift or review-gate drift", () => {
    const reporting = steps.filter(
      (step) => step.name === "Open a drift issue" || step.name === "Fail when drift exists",
    );

    expect(reporting).toHaveLength(2);
    for (const step of reporting) {
      expect(step.if).toContain("steps.drift.outputs.detected == 'true'");
      expect(step.if).toContain("steps.review_gate.outputs.detected == 'true'");
    }
  });
});
