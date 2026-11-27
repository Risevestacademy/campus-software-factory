import { describe, expect, test } from "vitest";

import {
  collectCanaryRecords,
  type ActiveCanary,
  type CanaryGitHub,
} from "../../src/review/canary-run.js";
import type { SuccessfulPullRequestRun } from "../../src/review/github-rest-adapter.js";

const canary: ActiveCanary = {
  githubRepository: "rise/campus-web",
  startsAt: "2026-10-25T09:00:00Z",
  review: {
    id: "campus-web",
    mode: "advisory",
    ciWorkflowName: "CI",
    targetBranches: ["dev", "main"],
    standardsPaths: ["AGENTS.md"],
    provider: { id: "claude", model: "claude-opus-5-5" },
    canaryStartsAt: "2026-10-25T09:00:00Z",
  },
};

function run(
  headSha: string,
  completedAt: string,
  overrides: Partial<SuccessfulPullRequestRun> = {},
): SuccessfulPullRequestRun {
  return {
    headSha,
    headRepository: "rise/campus-web",
    pullRequestNumbers: [21],
    completedAt,
    ...overrides,
  };
}

describe("collectCanaryRecords", () => {
  test("keeps one record per head, timed from its earliest run, with only completed factory checks", async () => {
    const github: CanaryGitHub = {
      listSuccessfulPullRequestRuns: async () => [
        run("sha-a", "2026-10-25T10:05:00Z"),
        run("sha-a", "2026-10-25T10:00:00Z"),
        run("sha-fork", "2026-10-25T10:00:00Z", { headRepository: "outsider/campus-web" }),
        run("sha-unlinked", "2026-10-25T10:00:00Z", { pullRequestNumbers: [] }),
      ],
      listFactoryCheckRuns: async () => [
        {
          id: 1,
          status: "completed",
          externalId: "factory-review:v1:clean:7",
          completedAt: "2026-10-25T10:03:00Z",
        },
        {
          id: 2,
          status: "in_progress",
          externalId: "factory-review:v1:findings:8",
          completedAt: null,
        },
        {
          id: 3,
          status: "completed",
          externalId: "unrelated",
          completedAt: "2026-10-25T10:04:00Z",
        },
      ],
      listPullRequestLabels: async () => ["factory-review:valid"],
    };

    await expect(collectCanaryRecords(github, canary)).resolves.toEqual([
      {
        pullRequestNumber: 21,
        headSha: "sha-a",
        ciCompletedAt: "2026-10-25T10:00:00Z",
        checks: [{ outcome: "clean", completedAt: "2026-10-25T10:03:00Z" }],
        labels: ["factory-review:valid"],
      },
    ]);
  });
});
