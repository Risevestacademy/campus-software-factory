import { readFile } from "node:fs/promises";

import { describe, expect, test, vi } from "vitest";

import {
  createClaudeReviewExecution,
  extractPrPurpose,
  formatReviewBody,
  isCanaryActive,
  parseReviewResult,
  type GitHubReviewPort,
  type ReviewFinding,
  type ReviewPolicy,
  type ReviewRun,
  type ReviewTicket,
} from "../../src/review/index.js";

const finding: ReviewFinding = {
  axis: "spec",
  severity: "P1",
  confidence: 0.97,
  path: "src/session.ts",
  line: 42,
  title: "Renewal drops the active presence session",
  evidence: "The replacement path clears presence before renewal completes.",
  failureScenario: "A renewing user is disconnected from the active cohort.",
  requestedChange: "Preserve presence until renewal succeeds or fails.",
  source: "PR acceptance criterion: preserve active campus state",
};

const policy: ReviewPolicy = {
  allowedRepository: "Risevestacademy/campus-web",
  ciWorkflowName: "Campus Web CI",
  canaryStartsAt: "2026-10-17T12:00:00.000Z",
  canaryEndsAt: "2026-10-20T12:00:00.000Z",
};

const run: ReviewRun = {
  repository: "Risevestacademy/campus-web",
  workflowRunId: 123,
  observedAt: new Date("2026-10-18T12:00:00.000Z"),
};

describe("ClaudeReviewExecution", () => {
  test("returns a ticket only for the current internal PR with a measurable purpose", async () => {
    const github = createGitHubPort();
    const execution = createClaudeReviewExecution(policy, github);

    await expect(execution.preflight(run)).resolves.toMatchObject({
      kind: "ready",
      ticket: {
        repository: "Risevestacademy/campus-web",
        pullRequestNumber: 21,
        baseSha: "base",
        headSha: "abc",
        purpose: "Renew sessions without interrupting active presence.",
        claimName: "campus-claude-invocation-abc",
      },
    });
  });

  test("skips a SHA that already owns an invocation claim", async () => {
    const github = createGitHubPort({ invocationClaimExists: true });
    const execution = createClaudeReviewExecution(policy, github);

    await expect(execution.preflight(run)).resolves.toEqual({
      kind: "skip",
      reason: "already-invoked",
    });
  });

  test("revalidates the head and publishes one advisory review", async () => {
    const github = createGitHubPort();
    const execution = createClaudeReviewExecution(policy, github);
    const preflight = await execution.preflight(run);
    if (preflight.kind !== "ready") {
      throw new Error("Expected a ready review ticket");
    }

    await expect(
      execution.publish({
        ticket: preflight.ticket,
        modelOutputJson: JSON.stringify({
          status: "findings",
          findings: [finding],
        }),
        observedAt: run.observedAt,
      }),
    ).resolves.toEqual({ kind: "published", reason: "findings-published" });
    expect(github.publishCommentReview).toHaveBeenCalledOnce();
  });

  test("keeps clean output silent", async () => {
    const github = createGitHubPort();
    const execution = createClaudeReviewExecution(policy, github);

    await expect(
      execution.publish({
        ticket: ticket(),
        modelOutputJson: JSON.stringify({ status: "clean", findings: [] }),
        observedAt: run.observedAt,
      }),
    ).resolves.toEqual({ kind: "skip", reason: "clean" });
    expect(github.publishCommentReview).not.toHaveBeenCalled();
  });
});

describe("parseReviewResult", () => {
  test("rejects unvalidated model fields", () => {
    expect(() =>
      parseReviewResult(
        JSON.stringify({
          status: "findings",
          purpose: "Model-controlled purpose",
          findings: [finding],
        }),
      ),
    ).toThrow(/unexpected property/i);
  });
});

describe("formatReviewBody", () => {
  test("keeps Standards and Spec separate in one deduplicated review", () => {
    const body = formatReviewBody(
      "abc",
      "Renew a session without interrupting presence.",
      [finding],
    );

    expect(body).toContain("<!-- campus-claude-review:abc -->");
    expect(body).toContain("## Standards");
    expect(body).toContain("## Spec");
    expect(body).toContain("src/session.ts:42");
  });
});

describe("extractPrPurpose", () => {
  test("reads the measurable outcome from the live factory PR template", async () => {
    const template = await readFile(
      new URL("../../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
      "utf8",
    );
    const populated = template.replace(
      "<!-- State what workflow, behavior, metric, log, trace, or score improves. -->",
      "Renew sessions without interrupting active campus presence.",
    );

    expect(extractPrPurpose(populated)).toBe(
      "Renew sessions without interrupting active campus presence.",
    );
  });
});

describe("isCanaryActive", () => {
  test("runs only inside the configured three-day window", () => {
    expect(
      isCanaryActive(
        policy.canaryStartsAt,
        policy.canaryEndsAt,
        new Date("2026-10-18T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  test("rejects a window longer than three days", () => {
    expect(() =>
      isCanaryActive(
        "2026-10-17T12:00:00.000Z",
        "2026-10-20T12:00:00.001Z",
        new Date("2026-10-18T12:00:00.000Z"),
      ),
    ).toThrow("Canary window must not exceed 72 hours");
  });
});

function ticket(): ReviewTicket {
  return {
    repository: "Risevestacademy/campus-web",
    workflowRunId: 123,
    pullRequestNumber: 21,
    baseSha: "base",
    headSha: "abc",
    purpose: "Renew sessions without interrupting active presence.",
    claimName: "campus-claude-invocation-abc",
  };
}

function createGitHubPort(
  options: { invocationClaimExists?: boolean } = {},
): GitHubReviewPort & {
  publishCommentReview: ReturnType<typeof vi.fn>;
} {
  return {
    getWorkflowRun: vi.fn().mockResolvedValue({
      name: "Campus Web CI",
      conclusion: "success",
      event: "pull_request",
      headSha: "abc",
      headRepository: "Risevestacademy/campus-web",
      pullRequestNumbers: [21],
    }),
    getPullRequest: vi.fn().mockResolvedValue({
      number: 21,
      state: "open",
      draft: false,
      baseSha: "base",
      headSha: "abc",
      headRepository: "Risevestacademy/campus-web",
      body: `## Change and measurable outcome

Renew sessions without interrupting active presence.`,
    }),
    hasInvocationClaim: vi
      .fn()
      .mockResolvedValue(options.invocationClaimExists ?? false),
    listReviewBodies: vi.fn().mockResolvedValue([]),
    publishCommentReview: vi.fn().mockResolvedValue(undefined),
  };
}
