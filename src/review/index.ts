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
  baseSha: string;
  headSha: string;
  headRepository: string;
  body: string;
}

export interface ReviewFinding {
  axis: "spec" | "standards";
  severity: "P0" | "P1" | "P2";
  confidence: number;
  path: string;
  line: number;
  title: string;
  evidence: string;
  failureScenario: string;
  requestedChange: string;
  source: string;
}

export type ReviewResult =
  | { status: "clean" | "missing_spec"; findings: [] }
  | { status: "findings"; findings: ReviewFinding[] };

export interface ReviewPolicy {
  allowedRepository: string;
  ciWorkflowName: string;
  canaryStartsAt: string;
  canaryEndsAt: string;
}

export interface ReviewRun {
  repository: string;
  workflowRunId: number;
  observedAt: Date;
}

export interface ReviewTicket {
  repository: string;
  workflowRunId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  purpose: string;
  claimName: string;
}

export interface GitHubReviewPort {
  getWorkflowRun(repository: string, workflowRunId: number): Promise<WorkflowRun>;
  getPullRequest(repository: string, pullRequestNumber: number): Promise<PullRequest>;
  hasInvocationClaim(repository: string, claimName: string): Promise<boolean>;
  listReviewBodies(repository: string, pullRequestNumber: number): Promise<string[]>;
  publishCommentReview(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<void>;
}

export type PreflightDecision =
  | { kind: "ready"; ticket: ReviewTicket }
  | { kind: "skip"; reason: PreflightSkipReason };

export type PublishDecision =
  | { kind: "published"; reason: "findings-published" }
  | { kind: "skip"; reason: PublishSkipReason };

type PreflightSkipReason =
  | "already-invoked"
  | "already-reviewed"
  | "canary-expired"
  | "ci-failed"
  | "draft"
  | "external-fork"
  | "not-open"
  | "repository-not-allowed"
  | "stale-head"
  | "unexpected-workflow"
  | "unsupported-event";

type PublishSkipReason =
  | PreflightSkipReason
  | "clean"
  | "purpose-changed"
  | "ticket-stale";

export type ReviewEligibility =
  | { eligible: true; reason: "eligible" }
  | {
      eligible: false;
      reason:
        | "ci-failed"
        | "draft"
        | "external-fork"
        | "not-open"
        | "stale-head"
        | "unsupported-event";
    };

export class ReviewExecutionError extends Error {
  readonly code: "invalid-run" | "missing-purpose" | "missing-spec";

  constructor(
    code: "invalid-run" | "missing-purpose" | "missing-spec",
    message: string,
  ) {
    super(message);
    this.name = "ReviewExecutionError";
    this.code = code;
  }
}

const maxFindings = 3;
const minimumConfidence = 0.9;
const maxCanaryDurationMilliseconds = 72 * 60 * 60 * 1_000;

export function createClaudeReviewExecution(
  policy: ReviewPolicy,
  github: GitHubReviewPort,
) {
  return {
    async preflight(run: ReviewRun): Promise<PreflightDecision> {
      if (run.repository !== policy.allowedRepository) {
        return { kind: "skip", reason: "repository-not-allowed" };
      }
      if (!isCanaryActive(policy.canaryStartsAt, policy.canaryEndsAt, run.observedAt)) {
        return { kind: "skip", reason: "canary-expired" };
      }
      validateWorkflowRunId(run.workflowRunId);

      const workflowRun = await github.getWorkflowRun(
        run.repository,
        run.workflowRunId,
      );
      if (workflowRun.name !== policy.ciWorkflowName) {
        return { kind: "skip", reason: "unexpected-workflow" };
      }
      const pullRequestNumber = onlyPullRequestNumber(workflowRun);
      const pullRequest = await github.getPullRequest(
        run.repository,
        pullRequestNumber,
      );
      const eligibility = determineReviewEligibility(
        run.repository,
        workflowRun,
        pullRequest,
      );
      if (!eligibility.eligible) {
        return { kind: "skip", reason: eligibility.reason };
      }

      const purpose = extractPrPurpose(pullRequest.body);
      if (purpose === null) {
        throw new ReviewExecutionError(
          "missing-purpose",
          "PR review requires a non-empty 'Change and measurable outcome' section",
        );
      }
      const claimName = invocationClaimName(pullRequest.headSha);
      if (await github.hasInvocationClaim(run.repository, claimName)) {
        return { kind: "skip", reason: "already-invoked" };
      }
      if (
        await hasReviewMarker(
          github,
          run.repository,
          pullRequestNumber,
          pullRequest.headSha,
        )
      ) {
        return { kind: "skip", reason: "already-reviewed" };
      }

      return {
        kind: "ready",
        ticket: {
          repository: run.repository,
          workflowRunId: run.workflowRunId,
          pullRequestNumber,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          purpose,
          claimName,
        },
      };
    },

    async publish(input: {
      ticket: ReviewTicket;
      modelOutputJson: string;
      observedAt: Date;
    }): Promise<PublishDecision> {
      const { ticket } = input;
      if (ticket.repository !== policy.allowedRepository) {
        return { kind: "skip", reason: "repository-not-allowed" };
      }
      if (
        !isCanaryActive(
          policy.canaryStartsAt,
          policy.canaryEndsAt,
          input.observedAt,
        )
      ) {
        return { kind: "skip", reason: "canary-expired" };
      }
      validateWorkflowRunId(ticket.workflowRunId);

      const workflowRun = await github.getWorkflowRun(
        ticket.repository,
        ticket.workflowRunId,
      );
      if (workflowRun.name !== policy.ciWorkflowName) {
        return { kind: "skip", reason: "unexpected-workflow" };
      }
      if (!workflowRun.pullRequestNumbers.includes(ticket.pullRequestNumber)) {
        return { kind: "skip", reason: "ticket-stale" };
      }
      const pullRequest = await github.getPullRequest(
        ticket.repository,
        ticket.pullRequestNumber,
      );
      const eligibility = determineReviewEligibility(
        ticket.repository,
        workflowRun,
        pullRequest,
      );
      if (!eligibility.eligible) {
        return { kind: "skip", reason: eligibility.reason };
      }
      if (
        pullRequest.baseSha !== ticket.baseSha ||
        pullRequest.headSha !== ticket.headSha
      ) {
        return { kind: "skip", reason: "ticket-stale" };
      }
      if (extractPrPurpose(pullRequest.body) !== ticket.purpose) {
        return { kind: "skip", reason: "purpose-changed" };
      }

      const review = parseReviewResult(input.modelOutputJson);
      if (review.status === "missing_spec") {
        throw new ReviewExecutionError(
          "missing-spec",
          "Claude could not establish the pull request specification",
        );
      }
      const findings = selectPublishableFindings(review);
      if (findings.length === 0) {
        return { kind: "skip", reason: "clean" };
      }
      if (
        await hasReviewMarker(
          github,
          ticket.repository,
          ticket.pullRequestNumber,
          ticket.headSha,
        )
      ) {
        return { kind: "skip", reason: "already-reviewed" };
      }

      await github.publishCommentReview(
        ticket.repository,
        ticket.pullRequestNumber,
        formatReviewBody(ticket.headSha, ticket.purpose, findings),
      );
      return { kind: "published", reason: "findings-published" };
    },
  };
}

export function determineReviewEligibility(
  repository: string,
  workflowRun: WorkflowRun,
  pullRequest: PullRequest,
): ReviewEligibility {
  if (workflowRun.conclusion !== "success") {
    return { eligible: false, reason: "ci-failed" };
  }
  if (workflowRun.event !== "pull_request") {
    return { eligible: false, reason: "unsupported-event" };
  }
  if (
    workflowRun.headRepository !== repository ||
    pullRequest.headRepository !== repository
  ) {
    return { eligible: false, reason: "external-fork" };
  }
  if (pullRequest.state !== "open") {
    return { eligible: false, reason: "not-open" };
  }
  if (pullRequest.draft) {
    return { eligible: false, reason: "draft" };
  }
  if (workflowRun.headSha !== pullRequest.headSha) {
    return { eligible: false, reason: "stale-head" };
  }
  return { eligible: true, reason: "eligible" };
}

export function parseReviewResult(source: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error("Claude review output must be valid JSON", { cause: error });
  }
  const result = requireExactObject(parsed, ["status", "findings"], "review result");
  const status = requireString(result.status, "review status");
  if (status !== "clean" && status !== "findings" && status !== "missing_spec") {
    throw new Error(`Unsupported review status "${status}"`);
  }
  if (!Array.isArray(result.findings)) {
    throw new Error("Review findings must be an array");
  }
  if (result.findings.length > maxFindings) {
    throw new Error(`Claude returned more than ${maxFindings} findings`);
  }
  const findings = result.findings.map(parseFinding);
  if (status !== "findings" && findings.length > 0) {
    throw new Error(`Review status "${status}" requires an empty findings array`);
  }
  if (status === "findings" && findings.length === 0) {
    throw new Error('Review status "findings" requires at least one finding');
  }
  return status === "findings"
    ? { status, findings }
    : { status, findings: [] };
}

export function selectPublishableFindings(review: ReviewResult): ReviewFinding[] {
  if (review.status !== "findings") {
    return [];
  }
  if (review.findings.length > maxFindings) {
    throw new Error(`Claude returned more than ${maxFindings} findings`);
  }
  return review.findings.filter(
    (finding) => finding.confidence >= minimumConfidence,
  );
}

export function formatReviewBody(
  headSha: string,
  purpose: string,
  findings: ReviewFinding[],
): string {
  const sections = (["standards", "spec"] as const).map((axis) => {
    const matchingFindings = findings.filter((finding) => finding.axis === axis);
    const content =
      matchingFindings.length === 0
        ? "No requested changes."
        : matchingFindings.map(formatFinding).join("\n\n");
    return `## ${axis === "standards" ? "Standards" : "Spec"}\n\n${content}`;
  });

  return [
    reviewMarker(headSha),
    "# Claude PR review",
    `**PR purpose:** ${purpose}`,
    ...sections,
  ].join("\n\n");
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

export function isCanaryActive(startsAt: string, endsAt: string, now: Date): boolean {
  const startTime = Date.parse(startsAt);
  const endTime = Date.parse(endsAt);
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) {
    throw new Error("Invalid canary window");
  }
  if (endTime - startTime > maxCanaryDurationMilliseconds) {
    throw new Error("Canary window must not exceed 72 hours");
  }
  return now.getTime() >= startTime && now.getTime() < endTime;
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  const label = `finding ${index}`;
  const finding = requireExactObject(
    value,
    [
      "axis",
      "severity",
      "confidence",
      "path",
      "line",
      "title",
      "evidence",
      "failureScenario",
      "requestedChange",
      "source",
    ],
    label,
  );
  const axis = requireString(finding.axis, `${label} axis`);
  const severity = requireString(finding.severity, `${label} severity`);
  const confidence = requireNumber(finding.confidence, `${label} confidence`);
  const line = requireNumber(finding.line, `${label} line`);
  if (axis !== "spec" && axis !== "standards") {
    throw new Error(`${label} has unsupported axis "${axis}"`);
  }
  if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
    throw new Error(`${label} has unsupported severity "${severity}"`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`${label} confidence must be between 0 and 1`);
  }
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} line must be a positive integer`);
  }
  return {
    axis,
    severity,
    confidence,
    path: requireString(finding.path, `${label} path`),
    line,
    title: requireString(finding.title, `${label} title`),
    evidence: requireString(finding.evidence, `${label} evidence`),
    failureScenario: requireString(
      finding.failureScenario,
      `${label} failure scenario`,
    ),
    requestedChange: requireString(
      finding.requestedChange,
      `${label} requested change`,
    ),
    source: requireString(finding.source, `${label} source`),
  };
}

function formatFinding(finding: ReviewFinding): string {
  return [
    `### ${finding.severity}: ${finding.title}`,
    `- Location: \`${finding.path}:${finding.line}\``,
    `- Evidence: ${finding.evidence}`,
    `- Failure scenario: ${finding.failureScenario}`,
    `- Required change: ${finding.requestedChange}`,
    `- Basis: ${finding.source}`,
  ].join("\n");
}

function onlyPullRequestNumber(workflowRun: WorkflowRun): number {
  if (workflowRun.pullRequestNumbers.length !== 1) {
    throw new ReviewExecutionError(
      "invalid-run",
      "CI workflow run must be associated with exactly one pull request",
    );
  }
  const number = workflowRun.pullRequestNumbers[0];
  if (number === undefined || !Number.isSafeInteger(number) || number < 1) {
    throw new ReviewExecutionError("invalid-run", "Invalid pull request number");
  }
  return number;
}

function validateWorkflowRunId(workflowRunId: number): void {
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1) {
    throw new ReviewExecutionError("invalid-run", "Invalid workflow run ID");
  }
}

async function hasReviewMarker(
  github: GitHubReviewPort,
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): Promise<boolean> {
  const marker = reviewMarker(headSha);
  return (await github.listReviewBodies(repository, pullRequestNumber)).some(
    (body) => body.includes(marker),
  );
}

function reviewMarker(headSha: string): string {
  return `<!-- campus-claude-review:${headSha} -->`;
}

function invocationClaimName(headSha: string): string {
  return `campus-claude-invocation-${headSha}`;
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const expectedKeys = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${label} has unexpected property "${key}"`);
    }
  }
  for (const key of keys) {
    if (!(key in object)) {
      throw new Error(`${label} is missing property "${key}"`);
    }
  }
  return object;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}
