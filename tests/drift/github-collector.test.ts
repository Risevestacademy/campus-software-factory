import { describe, expect, test } from "vitest";

import { normalizeRuleset } from "../../src/drift/github-collector.js";

describe("normalizeRuleset", () => {
  test("preserves every effective rule and target condition", () => {
    expect(
      normalizeRuleset({
        id: 1,
        name: "factory-quality",
        target: "branch",
        source: "rise/campus-web",
        source_type: "Repository",
        enforcement: "active",
        conditions: {
          ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        },
        bypass_actors: [
          { actor_id: 42, actor_type: "Team", bypass_mode: "pull_request" },
        ],
        rules: [
          {
            type: "pull_request",
            parameters: {
              require_last_push_approval: true,
              required_review_thread_resolution: true,
            },
          },
        ],
      }),
    ).toMatchObject({
      target: "branch",
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      },
      bypassActors: [
        { actorId: 42, actorType: "Team", bypassMode: "pull_request" },
      ],
      rules: [
        {
          type: "pull_request",
          parameters: {
            require_last_push_approval: true,
            required_review_thread_resolution: true,
          },
        },
      ],
    });
  });
});
