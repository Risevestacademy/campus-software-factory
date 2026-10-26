import { matchesPath } from "../policy/index.ts";
import {
  parseReviewResult,
  validateFindingLocations,
  type ChangedFile,
} from "./contracts.ts";
import {
  buildCheckRunReport,
  externalId,
  isDecisiveOutcome,
  parseExternalId,
  type CheckRunContext,
  type CheckRunReport,
  type ReviewOutcome,
} from "./check-run.ts";
import type {
  RepositoryReviewPolicy,
  ReviewSizeLimit,
} from "./provider-policy.ts";

export interface WorkflowRun {
  name: string;
  conclusion: string;
  event: string;
  headSha: string;
  headRepository: string;
  pullRequestNumbers: number[];
}

export interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headSha: string;
  headRepository: string;
  body: string;
}

export interface FactoryCheckRun {
  id: number;
  status: "queued" | "in_progress" | "completed";
  externalId: string | null;
  completedAt: string | null;
}

export interface ExecutionPolicy {
  repository: string;
  review: RepositoryReviewPolicy;
  sizeLimit: ReviewSizeLimit;
}

export interface ReviewRun {
  repository: string;
  workflowRunId: number;
}

export interface ReviewTicket {
  repository: string;
  workflowRunId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  purpose: string;
  checkRunId: number;
}

export interface GitHubReviewPort {
  getWorkflowRun(repository: string, workflowRunId: number): Promise<WorkflowRun>;
  getPullRequest(repository: string, pullRequestNumber: number): Promise<PullRequest>;
  listPullRequestFiles(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ChangedFile[]>;
  listFactoryCheckRuns(repository: string, headSha: string): Promise<FactoryCheckRun[]>;
  startCheckRun(repository: string, headSha: string, externalId: string): Promise<number>;
  publishCheckRun(
    repository: string,
    headSha: string,
    report: CheckRunReport,
  ): Promise<void>;
  completeCheckRun(
    repository: string,
    checkRunId: number,
    report: CheckRunReport,
  ): Promise<void>;
}

export type PreflightSkipReason =
  | "already-reviewed"
  | "ci-failed"
  | "disabled"
  | "draft"
  | "external-fork"
  | "missing-purpose"
  | "not-open"
  | "repository-not-allowed"
  | "stale-head"
  | "too-large"
  | "unexpected-workflow"
  | "unsupported-event"
  | "untargeted-branch";

export type PreflightDecision =
  | { kind: "ready"; ticket: ReviewTicket }
  | { kind: "skip"; reason: PreflightSkipReason };

export type ValidationDecision = { valid: true } | { valid: false; reason: string };

export interface PublishResult {
  outcome: ReviewOutcome["kind"];
  conclusion: CheckRunReport["conclusion"];
}

export type ReviewAttribution = Omit<
  CheckRunContext,
  "ciRunId" | "mode" | "purpose"
>;

export class ReviewExecutionError extends Error {
  readonly code = "invalid-run";

  constructor(message: string) {
    super(message);
    this.name = "ReviewExecutionError";
  }
}

export function createFactoryReviewExecution(
  policy: ExecutionPolicy,
  github: GitHubReviewPort,
) {
  const { review, sizeLimit } = policy;

  function context(
    ciRunId: number,
    purpose: string | null,
    attribution: ReviewAttribution = {
      provider: review.provider.id,
      model: review.provider.model,
    },
  ): CheckRunContext {
    return {
      ciRunId,
      mode: review.mode,
      purpose,
      ...attribution,
    };
  }

  async function evaluateOutput(
    ticket: ReviewTicket,
    modelOutputJson: string,
  ): Promise<ReviewOutcome> {
    const result = parseReviewResult(modelOutputJson);
    if (result.status === "missing_spec") {
      return { kind: "missing-purpose", reason: "too-vague" };
    }
    if (result.status === "clean") {
      return { kind: "clean" };
    }
    validateFindingLocations(
      result.findings,
      await github.listPullRequestFiles(ticket.repository, ticket.pullRequestNumber),
    );
    return { kind: "findings", findings: result.findings };
  }

  async function changedDuringReview(ticket: ReviewTicket): Promise<boolean> {
    const workflowRun = await github.getWorkflowRun(
      ticket.repository,
      ticket.workflowRunId,
    );
    const pullRequest = await github.getPullRequest(
      ticket.repository,
      ticket.pullRequestNumber,
    );
    return (
      workflowRun.headSha !== ticket.headSha ||
      !workflowRun.pullRequestNumbers.includes(ticket.pullRequestNumber) ||
      pullRequest.state !== "open" ||
      pullRequest.draft ||
      pullRequest.baseSha !== ticket.baseSha ||
      pullRequest.headSha !== ticket.headSha ||
      extractPrPurpose(pullRequest.body) !== ticket.purpose
    );
  }

  async function complete(
    ticket: ReviewTicket,
    outcome: ReviewOutcome,
    attribution?: ReviewAttribution,
  ): Promise<PublishResult> {
    const report = buildCheckRunReport(
      outcome,
      context(ticket.workflowRunId, ticket.purpose, attribution),
    );
    await github.completeCheckRun(ticket.repository, ticket.checkRunId, report);
    return { outcome: outcome.kind, conclusion: report.conclusion };
  }

  return {
    async preflight(run: ReviewRun): Promise<PreflightDecision> {
      if (run.repository !== policy.repository) {
        return skip("repository-not-allowed");
      }
      if (review.mode === "disabled") {
        return skip("disabled");
      }
      validateWorkflowRunId(run.workflowRunId);

      const workflowRun = await github.getWorkflowRun(run.repository, run.workflowRunId);
      if (workflowRun.name !== review.ciWorkflowName) {
        return skip("unexpected-workflow");
      }
      if (workflowRun.conclusion !== "success") {
        return skip("ci-failed");
      }
      if (workflowRun.event !== "pull_request") {
        return skip("unsupported-event");
      }
      // GitHub omits pull_requests for fork runs, so forks are decided from the run itself.
      if (workflowRun.headRepository !== run.repository) {
        await github.publishCheckRun(
          run.repository,
          workflowRun.headSha,
          buildCheckRunReport({ kind: "fork" }, context(run.workflowRunId, null)),
        );
        return skip("external-fork");
      }

      const pullRequest = await github.getPullRequest(
        run.repository,
        onlyPullRequestNumber(workflowRun),
      );
      if (pullRequest.state !== "open") {
        return skip("not-open");
      }
      if (pullRequest.draft) {
        return skip("draft");
      }
      if (pullRequest.headSha !== workflowRun.headSha) {
        return skip("stale-head");
      }
      if (!review.targetBranches.some((branch) => branch === pullRequest.baseRef)) {
        return skip("untargeted-branch");
      }

      const existingChecks = await github.listFactoryCheckRuns(
        run.repository,
        pullRequest.headSha,
      );
      if (existingChecks.some(isDecisiveCheck)) {
        return skip("already-reviewed");
      }

      const size = measurePullRequest(
        await github.listPullRequestFiles(run.repository, pullRequest.number),
        sizeLimit,
      );
      if (
        size.changedLines > sizeLimit.maxChangedLines ||
        size.changedFiles > sizeLimit.maxChangedFiles
      ) {
        await github.publishCheckRun(
          run.repository,
          pullRequest.headSha,
          buildCheckRunReport(
            {
              kind: "too-large",
              ...size,
              maxChangedLines: sizeLimit.maxChangedLines,
              maxChangedFiles: sizeLimit.maxChangedFiles,
            },
            context(run.workflowRunId, null),
          ),
        );
        return skip("too-large");
      }

      const purpose = extractPrPurpose(pullRequest.body);
      if (purpose === null) {
        await github.publishCheckRun(
          run.repository,
          pullRequest.headSha,
          buildCheckRunReport(
            { kind: "missing-purpose", reason: "absent" },
            context(run.workflowRunId, null),
          ),
        );
        return skip("missing-purpose");
      }

      const checkRunId = await github.startCheckRun(
        run.repository,
        pullRequest.headSha,
        externalId("pending", run.workflowRunId),
      );
      return {
        kind: "ready",
        ticket: {
          repository: run.repository,
          workflowRunId: run.workflowRunId,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          purpose,
          checkRunId,
        },
      };
    },

    async validate(input: {
      ticket: ReviewTicket;
      modelOutputJson: string;
    }): Promise<ValidationDecision> {
      try {
        await evaluateOutput(input.ticket, input.modelOutputJson);
        return { valid: true };
      } catch (error: unknown) {
        return { valid: false, reason: errorMessage(error) };
      }
    },

    async publish(input: {
      ticket: ReviewTicket;
      modelOutputJson: string;
      attribution?: ReviewAttribution;
    }): Promise<PublishResult> {
      const { ticket } = input;
      if (await changedDuringReview(ticket)) {
        return complete(ticket, {
          kind: "technical",
          reason: "pull request changed during review",
        }, input.attribution);
      }
      let outcome: ReviewOutcome;
      try {
        outcome = await evaluateOutput(ticket, input.modelOutputJson);
      } catch (error: unknown) {
        outcome = { kind: "technical", reason: errorMessage(error) };
      }
      return complete(ticket, outcome, input.attribution);
    },

    async fail(input: {
      ticket: ReviewTicket;
      reason: string;
      attribution?: ReviewAttribution;
    }): Promise<void> {
      await complete(
        input.ticket,
        { kind: "technical", reason: input.reason },
        input.attribution,
      );
    },
  };
}

export function extractPrPurpose(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === "## change and measurable outcome",
  );
  if (headingIndex === -1) {
    return null;
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line)) {
      break;
    }
    sectionLines.push(line);
  }
  const purpose = sectionLines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return purpose.length > 0 ? purpose : null;
}

function skip(reason: PreflightSkipReason): PreflightDecision {
  return { kind: "skip", reason };
}

function measurePullRequest(
  files: readonly ChangedFile[],
  sizeLimit: ReviewSizeLimit,
): { changedLines: number; changedFiles: number } {
  const included = files.filter(
    (file) =>
      !sizeLimit.excludedPaths.some((pattern) => matchesPath(file.path, pattern)),
  );
  return {
    changedLines: included.reduce(
      (total, file) => total + file.additions + file.deletions,
      0,
    ),
    changedFiles: included.length,
  };
}

function isDecisiveCheck(check: FactoryCheckRun): boolean {
  const parsed = parseExternalId(check.externalId);
  return (
    check.status === "completed" &&
    parsed !== null &&
    isDecisiveOutcome(parsed.outcome)
  );
}

function onlyPullRequestNumber(workflowRun: WorkflowRun): number {
  if (workflowRun.pullRequestNumbers.length !== 1) {
    throw new ReviewExecutionError(
      "CI workflow run must be associated with exactly one pull request",
    );
  }
  const number = workflowRun.pullRequestNumbers[0];
  if (number === undefined || !Number.isSafeInteger(number) || number < 1) {
    throw new ReviewExecutionError("Invalid pull request number");
  }
  return number;
}

function validateWorkflowRunId(workflowRunId: number): void {
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1) {
    throw new ReviewExecutionError("Invalid workflow run ID");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
