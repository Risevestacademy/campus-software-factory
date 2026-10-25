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
  const reviewed = inWindow.filter((record) => record.checks.length > 0);
  const decisiveChecks = reviewed.map((record) =>
    record.checks.filter((check) => isDecisiveOutcome(check.outcome)),
  );
  const technicalCount = reviewed
    .flatMap((record) => record.checks)
    .filter((check) => check.outcome === "technical").length;
  const decisiveCount = decisiveChecks.flat().length;
  const findingRecords = reviewed.filter((record) =>
    record.checks.some((check) => check.outcome === "findings"),
  );

  const results: CanaryResult[] = [
    atLeast("reviewed-pull-requests", reviewed.length, 1),
    atMost(
      "duplicate-reviews",
      decisiveChecks.filter((checks) => checks.length > 1).length,
      0,
    ),
    atMost(
      "unlabeled-findings",
      findingRecords.filter((record) => !hasDisposition(record)).length,
      0,
    ),
    atMost(
      "false-positives",
      reviewed.filter((record) =>
        record.labels.includes(dispositionLabels.falsePositive),
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
      nearestRankP95(decisionLatencies(reviewed)),
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
    reviewed.length >= criteria.minimumPullRequests || input.now.getTime() >= endTime;
  const report: CanaryReport = {
    decidable,
    passed: decidable && results.every((entry) => entry.passed),
    sample: reviewed.length,
    unreviewedHeads: inWindow.length - reviewed.length,
    windowEndsAt: new Date(endTime).toISOString(),
    results,
  };
  return decidable ? report : { ...report, reason: "insufficient evidence" };
}

function hasDisposition(record: CanaryRecord): boolean {
  return (
    record.labels.includes(dispositionLabels.valid) ||
    record.labels.includes(dispositionLabels.falsePositive)
  );
}

function decisionLatencies(records: readonly CanaryRecord[]): number[] {
  return records.flatMap((record) => {
    const decidedAt = record.checks
      .filter((check) => isDecisiveOutcome(check.outcome) && check.completedAt !== null)
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
