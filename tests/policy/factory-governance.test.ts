import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { auditCodeowners } from "../../src/drift/review-gate.js";

interface FactoryRuleset {
  rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
}

async function loadText(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("factory governance", () => {
  test("CODEOWNERS lists only the owner team so GitHub resolves every rule", async () => {
    const codeowners = await loadText(".github/CODEOWNERS");

    expect(
      auditCodeowners({
        repository: "Risevestacademy/campus-software-factory",
        ownerTeam: "Risevestacademy/campus",
        codeowners,
      }),
    ).toEqual([]);
  });

  test("factory-main requires only checks the self-check workflow reports", async () => {
    const workflow = parse(await loadText(".github/workflows/factory-self-check.yml")) as {
      jobs: Record<string, { name?: string }>;
    };
    const reported = Object.entries(workflow.jobs).map(([id, job]) => job.name ?? id);
    const ruleset = JSON.parse(
      await loadText("policies/rulesets/factory-main.json"),
    ) as FactoryRuleset;
    const required = ruleset.rules.flatMap(
      (rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? [],
    );

    expect(required.length).toBeGreaterThan(0);
    for (const context of required) {
      expect(reported, `${context} would never report and would block every merge`).toContain(
        context,
      );
    }
  });
});
