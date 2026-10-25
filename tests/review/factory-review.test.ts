import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  createFactoryReviewExecution,
  extractPrPurpose,
  parseReviewResult,
  type ChangedFile,
  type CheckRunReport,
  type FactoryCheckRun,
  type GitHubReviewPort,
  type PullRequest,
  type RepositoryReviewPolicy,
  type ReviewFinding,
  type ReviewTicket,
  type WorkflowRun,
} from "../../src/review/index.js";

const repository = "Risevestacademy/campus-web";

const sizeLimit = {
  maxChangedLines: 400,
  maxChangedFiles: 15,
  excludedPaths: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
};

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

const reviewPolicy: RepositoryReviewPolicy = {
  id: "campus-web",
  mode: "advisory",
  ciWorkflowName: "Campus Web CI",
  targetBranches: ["dev", "main"],
  provider: { id: "claude", model: "claude-opus-5-5" },
  canaryStartsAt: "2026-10-25T09:00:00Z",
  credential: { secret: "CLAUDE_CODE_OAUTH_TOKEN", ownership: "organization" },
};

const workflowRun: WorkflowRun = {
  name: "Campus Web CI",
  conclusion: "success",
  event: "pull_request",
  headSha: "abc",
  headRepository: repository,
  pullRequestNumbers: [21],
};

const pullRequest: PullRequest = {
  number: 21,
  state: "open",
  draft: false,
  baseRef: "dev",
  baseSha: "base",
  headSha: "abc",
  headRepository: repository,
  body: "## Change and measurable outcome\n\nRenew sessions without interrupting active presence.",
};

const changedFiles: ChangedFile[] = [
  {
    path: "src/session.ts",
    patch: "@@ -40,3 +40,4 @@\n a\n+b\n c\n d",
    additions: 1,
    deletions: 0,
  },
];

interface FakeGitHub {
  port: GitHubReviewPort;
  started: Array<{ headSha: string; externalId: string }>;
  published: Array<{ headSha: string; report: CheckRunReport }>;
  completed: Array<{ checkRunId: number; report: CheckRunReport }>;
  changePullRequest(change: Partial<PullRequest>): void;
}

function createGitHub(
  options: {
    workflowRun?: Partial<WorkflowRun>;
    pullRequest?: Partial<PullRequest>;
    checkRuns?: FactoryCheckRun[];
    changedFiles?: ChangedFile[];
  } = {},
): FakeGitHub {
  let currentPullRequest = { ...pullRequest, ...options.pullRequest };
  const fake: FakeGitHub = {
    started: [],
    published: [],
    completed: [],
    changePullRequest(change) {
      currentPullRequest = { ...currentPullRequest, ...change };
    },
    port: {
      getWorkflowRun: async () => ({ ...workflowRun, ...options.workflowRun }),
      getPullRequest: async () => currentPullRequest,
      listPullRequestFiles: async () => options.changedFiles ?? changedFiles,
      listFactoryCheckRuns: async () => options.checkRuns ?? [],
      startCheckRun: async (_repository, headSha, externalId) => {
        fake.started.push({ headSha, externalId });
        return 900;
      },
      publishCheckRun: async (_repository, headSha, report) => {
        fake.published.push({ headSha, report });
      },
      completeCheckRun: async (_repository, checkRunId, report) => {
        fake.completed.push({ checkRunId, report });
      },
    },
  };
  return fake;
}

function execution(github: FakeGitHub, review: Partial<RepositoryReviewPolicy> = {}) {
  return createFactoryReviewExecution(
    { repository, review: { ...reviewPolicy, ...review }, sizeLimit },
    github.port,
  );
}

const run = { repository, workflowRunId: 123 };

async function readyTicket(github: FakeGitHub): Promise<ReviewTicket> {
  const decision = await execution(github).preflight(run);
  if (decision.kind !== "ready") {
    throw new Error(`Expected a ready ticket, got ${decision.reason}`);
  }
  return decision.ticket;
}

const findingsOutput = JSON.stringify({ status: "findings", findings: [finding] });
const cleanOutput = JSON.stringify({ status: "clean", findings: [] });

describe("FactoryReviewExecution.preflight", () => {
  test("starts one pending check and returns a ticket for an eligible head", async () => {
    const github = createGitHub();

    await expect(execution(github).preflight(run)).resolves.toEqual({
      kind: "ready",
      ticket: {
        repository,
        workflowRunId: 123,
        pullRequestNumber: 21,
        baseSha: "base",
        headSha: "abc",
        purpose: "Renew sessions without interrupting active presence.",
        checkRunId: 900,
      },
    });
    expect(github.started).toEqual([
      { headSha: "abc", externalId: "factory-review:v1:pending:123" },
    ]);
  });

  test.each([
    ["disabled repository", {}, { mode: "disabled" as const }, "disabled"],
    ["failed CI", { workflowRun: { conclusion: "failure" } }, {}, "ci-failed"],
    ["push event", { workflowRun: { event: "push" } }, {}, "unsupported-event"],
    ["unexpected workflow", { workflowRun: { name: "Railway plan" } }, {}, "unexpected-workflow"],
    ["closed PR", { pullRequest: { state: "closed" } }, {}, "not-open"],
    ["draft PR", { pullRequest: { draft: true } }, {}, "draft"],
    ["stale head", { pullRequest: { headSha: "newer" } }, {}, "stale-head"],
    ["untargeted base", { pullRequest: { baseRef: "feature/x" } }, {}, "untargeted-branch"],
  ])("publishes no check for a %s", async (_label, github, review, reason) => {
    const fake = createGitHub(github);

    await expect(execution(fake, review).preflight(run)).resolves.toEqual({
      kind: "skip",
      reason,
    });
    expect(fake.started).toEqual([]);
    expect(fake.published).toEqual([]);
  });

  test("marks a fork head neutral before any provider credential is used", async () => {
    const github = createGitHub({
      workflowRun: { headRepository: "outsider/campus-web", pullRequestNumbers: [] },
    });

    await expect(execution(github).preflight(run)).resolves.toEqual({
      kind: "skip",
      reason: "external-fork",
    });
    expect(github.published).toEqual([
      {
        headSha: "abc",
        report: expect.objectContaining({ conclusion: "neutral" }) as CheckRunReport,
      },
    ]);
    expect(github.started).toEqual([]);
  });

  test("fails a missing purpose without invoking the provider", async () => {
    const github = createGitHub({ pullRequest: { body: "No template" } });

    await expect(execution(github).preflight(run)).resolves.toEqual({
      kind: "skip",
      reason: "missing-purpose",
    });
    expect(github.published.map((entry) => entry.report.externalId)).toEqual([
      "factory-review:v1:missing-purpose:123",
    ]);
    expect(github.started).toEqual([]);
  });

  test("refuses to re-roll a SHA that already has a decisive result", async () => {
    const github = createGitHub({
      checkRuns: [
        { id: 1, status: "completed", externalId: "factory-review:v1:findings:100", completedAt: null },
      ],
    });

    await expect(execution(github).preflight(run)).resolves.toEqual({
      kind: "skip",
      reason: "already-reviewed",
    });
    expect(github.started).toEqual([]);
  });

  test("allows a same-SHA rerun after a technical failure or orphaned pending check", async () => {
    const github = createGitHub({
      checkRuns: [
        { id: 1, status: "completed", externalId: "factory-review:v1:technical:100", completedAt: null },
        { id: 2, status: "in_progress", externalId: "factory-review:v1:pending:101", completedAt: null },
      ],
    });

    await expect(execution(github).preflight(run)).resolves.toMatchObject({
      kind: "ready",
    });
  });

  test("reviews a pull request exactly at both size limits", async () => {
    const github = createGitHub({ changedFiles: sizedFiles(15, 400) });

    await expect(execution(github).preflight(run)).resolves.toMatchObject({
      kind: "ready",
    });
    expect(github.started).toHaveLength(1);
  });

  test.each([
    ["one changed line over", sizedFiles(15, 401)],
    ["one changed file over", sizedFiles(16, 400)],
  ])("marks a pull request %s as human-review-only", async (_label, files) => {
    const github = createGitHub({
      pullRequest: { body: "No purpose section" },
      changedFiles: files,
    });

    await expect(execution(github).preflight(run)).resolves.toEqual({
      kind: "skip",
      reason: "too-large",
    });
    expect(github.started).toEqual([]);
    expect(github.published).toEqual([
      {
        headSha: "abc",
        report: expect.objectContaining({
          conclusion: "neutral",
          externalId: "factory-review:v1:too-large:123",
          title: "Human review only (PR too large)",
        }) as CheckRunReport,
      },
    ]);
  });

  test("excludes lockfiles from changed-line and changed-file limits", async () => {
    const github = createGitHub({
      changedFiles: [
        {
          path: "pnpm-lock.yaml",
          patch: null,
          additions: 10_000,
          deletions: 10_000,
        },
        {
          path: "package-lock.json",
          patch: null,
          additions: 10_000,
          deletions: 10_000,
        },
        {
          path: "yarn.lock",
          patch: null,
          additions: 10_000,
          deletions: 10_000,
        },
      ],
    });

    await expect(execution(github).preflight(run)).resolves.toMatchObject({
      kind: "ready",
    });
  });
});

function sizedFiles(fileCount: number, changedLines: number): ChangedFile[] {
  return Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${index}.ts`,
    patch: null,
    additions: index === 0 ? changedLines - fileCount + 1 : 1,
    deletions: 0,
  }));
}

describe("FactoryReviewExecution.publish", () => {
  test("completes the pending check as success for a clean review", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);

    await expect(
      execution(github).publish({ ticket, modelOutputJson: cleanOutput }),
    ).resolves.toEqual({ outcome: "clean", conclusion: "success" });
    expect(github.completed).toEqual([
      {
        checkRunId: 900,
        report: expect.objectContaining({
          externalId: "factory-review:v1:clean:123",
        }) as CheckRunReport,
      },
    ]);
  });

  test("completes the pending check as failure with an annotation per finding", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);

    await expect(
      execution(github).publish({ ticket, modelOutputJson: findingsOutput }),
    ).resolves.toEqual({ outcome: "findings", conclusion: "failure" });
    expect(github.completed[0]?.report.annotations).toEqual([
      expect.objectContaining({ path: "src/session.ts", startLine: 42 }),
    ]);
  });

  test.each([
    ["malformed JSON", "not json", /valid JSON/],
    [
      "a finding outside the changed hunks",
      JSON.stringify({ status: "findings", findings: [{ ...finding, line: 7 }] }),
      /outside the changed hunks/,
    ],
  ])("turns %s into a technical failure", async (_label, output, reason) => {
    const github = createGitHub();
    const ticket = await readyTicket(github);

    await expect(
      execution(github).publish({ ticket, modelOutputJson: output }),
    ).resolves.toEqual({ outcome: "technical", conclusion: "failure" });
    expect(github.completed[0]?.report.summary).toMatch(reason);
  });

  test("never passes a head that moved during review", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);
    github.changePullRequest({ headSha: "newer" });

    await expect(
      execution(github).publish({ ticket, modelOutputJson: cleanOutput }),
    ).resolves.toEqual({ outcome: "technical", conclusion: "failure" });
    expect(github.completed[0]?.report.summary).toContain(
      "pull request changed during review",
    );
  });

  test("asks for a usable purpose when the reviewer cannot establish the spec", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);

    await expect(
      execution(github).publish({
        ticket,
        modelOutputJson: JSON.stringify({ status: "missing_spec", findings: [] }),
      }),
    ).resolves.toEqual({ outcome: "missing-purpose", conclusion: "failure" });
    expect(github.completed[0]?.report.summary).toContain("too vague to review against");
  });
});

describe("FactoryReviewExecution.validate", () => {
  test("accepts valid output and explains invalid output for the retry decision", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);
    const review = execution(github);

    await expect(
      review.validate({ ticket, modelOutputJson: findingsOutput }),
    ).resolves.toEqual({ valid: true });
    await expect(
      review.validate({ ticket, modelOutputJson: "not json" }),
    ).resolves.toEqual({ valid: false, reason: "Review output must be valid JSON" });
    expect(github.completed).toEqual([]);
  });
});

describe("FactoryReviewExecution.fail", () => {
  test("completes the pending check as a rerunnable technical failure", async () => {
    const github = createGitHub();
    const ticket = await readyTicket(github);

    await execution(github).fail({ ticket, reason: "provider step timed out" });

    expect(github.completed).toEqual([
      {
        checkRunId: 900,
        report: expect.objectContaining({
          conclusion: "failure",
          externalId: "factory-review:v1:technical:123",
        }) as CheckRunReport,
      },
    ]);
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
    ).toThrow("/ must NOT have additional properties");
  });

  test("rejects findings below the blocking confidence floor", () => {
    expect(() =>
      parseReviewResult(
        JSON.stringify({
          status: "findings",
          findings: [{ ...finding, confidence: 0.89 }],
        }),
      ),
    ).toThrow("/findings/0/confidence must be >= 0.9");
  });

  test("enforces the output schema length limits on model text", () => {
    expect(() =>
      parseReviewResult(
        JSON.stringify({ status: "findings", findings: [{ ...finding, title: "x".repeat(201) }] }),
      ),
    ).toThrow("/findings/0/title must NOT have more than 200 characters");
  });

  test("rejects a fractional finding line", () => {
    expect(() =>
      parseReviewResult(
        JSON.stringify({ status: "findings", findings: [{ ...finding, line: 42.5 }] }),
      ),
    ).toThrow("/findings/0/line must be integer");
  });

  test("rejects whitespace-only finding text", () => {
    expect(() =>
      parseReviewResult(
        JSON.stringify({ status: "findings", findings: [{ ...finding, evidence: "   " }] }),
      ),
    ).toThrow("finding 0 evidence must not be blank");
  });

  test("rejects a status that contradicts its findings", () => {
    expect(() =>
      parseReviewResult(JSON.stringify({ status: "clean", findings: [finding] })),
    ).toThrow('Review status "clean" requires an empty findings array');
    expect(() =>
      parseReviewResult(JSON.stringify({ status: "findings", findings: [] })),
    ).toThrow('Review status "findings" requires at least one finding');
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
