import { isDecisiveOutcome, type CheckOutcomeTag } from "./check-run.ts";
import type { CanaryCriteria } from "./provider-policy.ts";

export const dispositionLabels = {
  valid: "factory-review:valid",
  falsePositive: "factory-review:false-positive",
} as const;

export interface CanaryRecord {
  pullRequestNumber: number;
  headSha: string;
  ciCompletedAt: string;
  checks: Array<{ outcome: CheckOutcomeTag; completedAt: string | null }>;
  labels: string[];
}

export interface CanaryAttestation {
  credentialIncidents: number | null;
  unsafeReviews: number | null;
  humanApprovalIntact: boolean | null;
}

export interface CanaryResult {
  name: string;
  value: number | boolean | null;
  limit: string;
  passed: boolean;
}

export interface CanaryReport {
  decidable: boolean;
  passed: boolean;
  reason?: string;
  sample: number;
  unreviewedHeads: number;
  windowEndsAt: string;
  results: CanaryResult[];
}

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const minuteMilliseconds = 60 * 1_000;

export function evaluateCanary(input: {
  records: readonly CanaryRecord[];
  attestation: CanaryAttestation;
  criteria: CanaryCriteria;
  startsAt: string;
  now: Date;
}): CanaryReport {
  const { attestation, criteria } = input;
  const startTime = Date.parse(input.startsAt);
  const endTime = startTime + criteria.maxDays * dayMilliseconds;
  const inWindow = input.records.filter((record) => {
    const ciTime = Date.parse(record.ciCompletedAt);
    return ciTime >= startTime && ciTime < endTime;
  });
  const reviewable = inWindow.filter(
    (record) => !record.checks.some((check) => check.outcome === "too-large"),
  );
  const decided = reviewable.filter(
    (record) => decisiveChecksOf(record).length > 0,
  );
  const pullRequests = verdictsByPullRequest(decided);
  const technicalCount = reviewable
    .flatMap((record) => record.checks)
    .filter((check) => check.outcome === "technical").length;
  const decisiveCount = decided.flatMap(decisiveChecksOf).length;

  const results: CanaryResult[] = [
    atLeast("reviewed-pull-requests", pullRequests.length, 1),
    atMost(
      "duplicate-reviews",
      decided.filter((record) => decisiveChecksOf(record).length > 1).length,
      0,
    ),
    atMost(
      "unlabeled-findings",
      pullRequests.filter(
        (pullRequest) => pullRequest.hadFindings && !hasDisposition(pullRequest.labels),
      ).length,
      0,
    ),
    atMost(
      "false-positives",
      pullRequests.filter((pullRequest) =>
        pullRequest.labels.has(dispositionLabels.falsePositive),
      ).length,
      criteria.maxFalsePositives,
    ),
    atMost(
      "technical-error-rate",
      technicalCount + decisiveCount === 0
        ? 0
        : technicalCount / (technicalCount + decisiveCount),
      criteria.maxTechnicalErrorRate,
    ),
    atMost(
      "p95-latency-minutes",
      nearestRankP95(decisionLatencies(decided)),
      criteria.maxP95LatencyMinutes,
    ),
    attestedZero("credential-incidents", attestation.credentialIncidents),
    attestedZero("unsafe-reviews", attestation.unsafeReviews),
    {
      name: "human-approval-intact",
      value: attestation.humanApprovalIntact,
      limit: "attested true",
      passed: attestation.humanApprovalIntact === true,
    },
  ];

  const decidable =
    pullRequests.length >= criteria.minimumPullRequests || input.now.getTime() >= endTime;
  const report: CanaryReport = {
    decidable,
    passed: decidable && results.every((entry) => entry.passed),
    sample: pullRequests.length,
    unreviewedHeads: reviewable.length - decided.length,
    windowEndsAt: new Date(endTime).toISOString(),
    results,
  };
  return decidable ? report : { ...report, reason: "insufficient evidence" };
}

interface PullRequestVerdicts {
  hadFindings: boolean;
  labels: Set<string>;
}

function decisiveChecksOf(record: CanaryRecord): CanaryRecord["checks"] {
  return record.checks.filter((check) => isDecisiveOutcome(check.outcome));
}

// The canary threshold and disposition labels are per pull request, while
// records are per head SHA: one PR pushed ten times is still one sample.
function verdictsByPullRequest(records: readonly CanaryRecord[]): PullRequestVerdicts[] {
  const byNumber = new Map<number, PullRequestVerdicts>();
  for (const record of records) {
    const verdicts = byNumber.get(record.pullRequestNumber) ?? {
      hadFindings: false,
      labels: new Set<string>(),
    };
    verdicts.hadFindings ||= record.checks.some((check) => check.outcome === "findings");
    record.labels.forEach((label) => verdicts.labels.add(label));
    byNumber.set(record.pullRequestNumber, verdicts);
  }
  return [...byNumber.values()];
}

function hasDisposition(labels: ReadonlySet<string>): boolean {
  return labels.has(dispositionLabels.valid) || labels.has(dispositionLabels.falsePositive);
}

function decisionLatencies(records: readonly CanaryRecord[]): number[] {
  return records.flatMap((record) => {
    const decidedAt = decisiveChecksOf(record)
      .filter((check) => check.completedAt !== null)
      .map((check) => Date.parse(check.completedAt ?? ""))
      .sort((left, right) => left - right)[0];
    return decidedAt === undefined
      ? []
      : [(decidedAt - Date.parse(record.ciCompletedAt)) / minuteMilliseconds];
  });
}

function nearestRankP95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

function atMost(name: string, value: number, limit: number): CanaryResult {
  return { name, value, limit: `<= ${limit}`, passed: value <= limit };
}

function atLeast(name: string, value: number, limit: number): CanaryResult {
  return { name, value, limit: `>= ${limit}`, passed: value >= limit };
}

function attestedZero(name: string, value: number | null): CanaryResult {
  return { name, value, limit: "attested 0", passed: value === 0 };
}
