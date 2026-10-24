import { describe, expect, test } from "vitest";

import { parseRulesetSnapshot } from "../../src/drift/schema.js";

describe("parseRulesetSnapshot", () => {
  test("rejects malformed nested pull-request parameters", () => {
    expect(() =>
      parseRulesetSnapshot(
        JSON.stringify({
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
                  conditions: {},
                  bypassActors: [],
                  rules: [{ type: "pull_request", parameters: [] }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/parameters/);
  });
});
