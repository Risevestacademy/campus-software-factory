import { describe, expect, test } from "vitest";

import {
  compareRulesetSnapshots,
  type RulesetSnapshot,
} from "../../src/drift/index.js";

const expected: RulesetSnapshot = {
  repositories: [
    {
      repository: "rise/campus-web",
      rulesets: [
        {
          name: "factory-quality",
          target: "branch",
          source: "rise/campus-web",
          sourceType: "Repository",
          enforcement: "active",
          conditions: {
            ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
          },
          bypassActors: [],
          rules: [
            {
              type: "pull_request",
              parameters: {
                required_approving_review_count: 1,
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: true,
                require_last_push_approval: true,
                required_review_thread_resolution: true,
              },
            },
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [{ context: "quality-gate" }],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("compareRulesetSnapshots", () => {
  test("exposes a removed latest-change approval requirement", () => {
    const actual = structuredClone(expected);
    const pullRequestRule = actual.repositories[0]?.rulesets[0]?.rules[0];
    if (pullRequestRule?.parameters === undefined) {
      throw new Error("Test fixture is missing pull-request parameters");
    }
    pullRequestRule.parameters.require_last_push_approval = false;

    expect(compareRulesetSnapshots(expected, actual)).toContainEqual({
      kind: "changed",
      path: "rise/campus-web/rulesets/factory-quality/rules/0/parameters/require_last_push_approval",
      expected: true,
      actual: false,
    });
  });

  test("ignores ordering when the effective configuration is equal", () => {
    const actual = structuredClone(expected);
    const ruleset = actual.repositories[0]?.rulesets[0];
    if (ruleset === undefined) {
      throw new Error("Test fixture is missing a ruleset");
    }
    ruleset.rules.reverse();

    expect(compareRulesetSnapshots(expected, actual)).toEqual([]);
  });
});
