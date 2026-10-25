import { afterEach, describe, expect, test, vi } from "vitest";

import {
  collectCodeowners,
  normalizeRuleset,
  resolveTeamId,
} from "../../src/drift/github-collector.js";

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

describe("review gate collection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponses(responses: Record<string, unknown>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com", "");
        return path in responses
          ? new Response(JSON.stringify(responses[path]), { status: 200 })
          : new Response("{}", { status: 404, statusText: "Not Found" });
      }),
    );
  }

  test("reads CODEOWNERS from the first conventional location that exists", async () => {
    stubResponses({
      "/repos/rise/campus-web/contents/CODEOWNERS": {
        content: Buffer.from("* @rise/campus-web\n").toString("base64"),
      },
    });

    await expect(collectCodeowners("rise/campus-web", "token")).resolves.toBe(
      "* @rise/campus-web\n",
    );
  });

  test("reports a repository without CODEOWNERS as null", async () => {
    stubResponses({});

    await expect(collectCodeowners("rise/campus-web", "token")).resolves.toBeNull();
  });

  test("resolves an owner team id and reports a missing team as null", async () => {
    stubResponses({ "/orgs/rise/teams/campus-web": { id: 42 } });

    await expect(resolveTeamId("rise/campus-web", "token")).resolves.toBe(42);
    await expect(resolveTeamId("rise/campus-mobile", "token")).resolves.toBeNull();
  });
});
