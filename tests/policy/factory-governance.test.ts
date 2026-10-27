import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { auditCodeowners } from "../../src/drift/review-gate.js";

const ownerTeam = "Risevestacademy/campus";
const ownerTeamId = 20303158;

interface RulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

interface FactoryRuleset {
  conditions: { ref_name: { include: string[] } };
  bypass_actors: { actor_id: number; actor_type: string; bypass_mode: string }[];
  rules: RulesetRule[];
}

async function loadText(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

async function loadRuleset(): Promise<FactoryRuleset> {
  return JSON.parse(await loadText("policies/rulesets/factory-main.json")) as FactoryRuleset;
}

function rule(ruleset: FactoryRuleset, type: string): RulesetRule | undefined {
  return ruleset.rules.find((entry) => entry.type === type);
}

describe("factory CODEOWNERS", () => {
  test("lists only the owner team so GitHub resolves every rule", async () => {
    const codeowners = await loadText(".github/CODEOWNERS");

    expect(
      auditCodeowners({
        repository: "Risevestacademy/campus-software-factory",
        ownerTeam,
        codeowners,
      }),
    ).toEqual([]);
  });
});

describe("factory-main ruleset", () => {
  test("requires the job name the self-check workflow reports", async () => {
    const workflow = parse(await loadText(".github/workflows/factory-self-check.yml")) as {
      jobs: Record<string, { name?: string }>;
    };
    const reportedChecks = Object.entries(workflow.jobs).map(([id, job]) => job.name ?? id);
    const required = rule(await loadRuleset(), "required_status_checks")?.parameters
      ?.required_status_checks as { context: string }[];

    expect(required.map((check) => check.context)).toEqual(["quality-gate"]);
    expect(reportedChecks).toContain("quality-gate");
  });

  test("protects the default branch from deletion, force push and direct push", async () => {
    const ruleset = await loadRuleset();

    expect(ruleset.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(rule(ruleset, "deletion")).toBeDefined();
    expect(rule(ruleset, "non_fast_forward")).toBeDefined();
    expect(rule(ruleset, "pull_request")).toBeDefined();
  });

  test("lets only the owner team bypass, and only through a pull request", async () => {
    expect((await loadRuleset()).bypass_actors).toEqual([
      { actor_id: ownerTeamId, actor_type: "Team", bypass_mode: "pull_request" },
    ]);
  });

  test("requires a code owner approval of the latest push", async () => {
    expect(rule(await loadRuleset(), "pull_request")?.parameters).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: true,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: true,
    });
  });
});
