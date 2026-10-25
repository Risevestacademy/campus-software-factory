import { describe, expect, test } from "vitest";

import type { RulesetDefinition } from "../../src/drift/index.js";
import { auditReviewGate, type ReviewGateInput } from "../../src/drift/review-gate.js";

const repository = "Risevestacademy/campus-web";
const ownerTeam = "Risevestacademy/campus-web";

function qualityRuleset(
  overrides: Partial<RulesetDefinition> = {},
  requiredContexts: string[] = ["quality-gate", "Factory PR Review"],
): RulesetDefinition {
  return {
    name: "factory-quality",
    target: "branch",
    source: repository,
    sourceType: "Repository",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["refs/heads/dev", "refs/heads/main"], exclude: [] },
    },
    bypassActors: [{ actorId: 42, actorType: "Team", bypassMode: "pull_request" }],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: requiredContexts.map((context) => ({ context })),
        },
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    repository,
    ownerTeam,
    ownerTeamId: 42,
    codeowners: "# Product owners\n\n* @Risevestacademy/campus-web\n",
    mode: "enforced",
    rulesets: [qualityRuleset()],
    ...overrides,
  };
}

function paths(gate: ReviewGateInput): string[] {
  return auditReviewGate(gate).map((finding) => finding.path);
}

describe("auditReviewGate", () => {
  test("accepts CODEOWNERS that names only the owner team", () => {
    expect(
      auditReviewGate(input({ codeowners: "* @risevestacademy/CAMPUS-WEB\n" })),
    ).toEqual([]);
  });

  test("accepts specialist teams alongside the owner team", () => {
    expect(
      auditReviewGate(
        input({
          codeowners:
            "* @Risevestacademy/campus-web\n/.github/ @Risevestacademy/campus-web @Risevestacademy/campus-security\n",
        }),
      ),
    ).toEqual([]);
  });

  test("flags a rule that omits the owner team", () => {
    expect(paths(input({ codeowners: "/docs/ @Risevestacademy/campus-security\n" }))).toEqual([
      `${repository}/CODEOWNERS:1`,
    ]);
  });

  test("flags a CODEOWNERS line that names individual users", () => {
    expect(
      auditReviewGate(input({ codeowners: "* @lowlifehighway @aj1732\n" })),
    ).toEqual([
      {
        kind: "changed",
        path: `${repository}/CODEOWNERS:1`,
        expected: "includes @Risevestacademy/campus-web; team owners only",
        actual: ["@lowlifehighway", "@aj1732"],
      },
    ]);
  });

  test("flags a missing CODEOWNERS file", () => {
    expect(paths(input({ codeowners: null }))).toEqual([`${repository}/CODEOWNERS`]);
  });

  test("flags a missing owner team", () => {
    expect(paths(input({ ownerTeamId: null }))).toContain(
      `${repository}/teams/${ownerTeam}`,
    );
  });

  test.each([
    [
      "an extra actor",
      [
        { actorId: 42, actorType: "Team", bypassMode: "pull_request" },
        { actorId: 5, actorType: "RepositoryRole", bypassMode: "always" },
      ],
    ],
    ["the wrong bypass mode", [{ actorId: 42, actorType: "Team", bypassMode: "always" }]],
    ["no bypass actor", []],
  ])("requires only the owner team as pull_request bypass, flagging %s", (_label, bypassActors) => {
    expect(paths(input({ rulesets: [qualityRuleset({ bypassActors })] }))).toEqual([
      `${repository}/factory-quality/bypassActors`,
    ]);
  });

  test("requires Factory PR Review once enforced", () => {
    expect(
      paths(input({ rulesets: [qualityRuleset({}, ["quality-gate"])] })),
    ).toEqual([`${repository}/factory-quality/required_status_checks`]);
  });

  test("requires enforcement on both dev and main", () => {
    expect(
      paths(
        input({
          rulesets: [
            qualityRuleset({
              conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
            }),
          ],
        }),
      ),
    ).toEqual([`${repository}/factory-quality/conditions`]);
  });

  test("flags premature enforcement during the advisory canary", () => {
    expect(paths(input({ mode: "advisory" }))).toEqual([
      `${repository}/factory-quality/required_status_checks`,
    ]);
    expect(
      auditReviewGate(
        input({ mode: "advisory", rulesets: [qualityRuleset({}, ["quality-gate"])] }),
      ),
    ).toEqual([]);
  });

  test("flags a missing factory-quality ruleset for an active repository", () => {
    expect(paths(input({ rulesets: [] }))).toEqual([`${repository}/factory-quality`]);
  });
});
