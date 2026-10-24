export interface BusinessSchedule {
  utcOffsetMinutes: number;
  weekdays: readonly number[];
  startMinute: number;
  endMinute: number;
  holidays: readonly string[];
}

export interface PullRequestMetric {
  repository: string;
  readyAt: string;
  firstHumanResponseAt?: string;
  firstApprovalAt?: string;
  readyToMergeAt?: string;
  eligibleAt?: string;
  mergedAt?: string;
  mergerTeam?: string;
  specialistRequired: boolean;
  specialistSatisfied: boolean;
}

export interface DeploymentMetric {
  id: string;
  repository: string;
  environment: "staging" | "production";
  status: "succeeded" | "failed";
  completedAt: string;
}

export interface RevertMetric {
  repository: string;
  deploymentId: string;
  occurredAt: string;
}

export interface IncidentMetric {
  repository: string;
  deploymentId?: string;
  severity: "Sev1" | "Sev2" | "Sev3" | "Sev4";
  factoryCaused: boolean;
  openedAt: string;
}

export interface MetricsWindow {
  startsAt: string;
  endsAt: string;
  pullRequests: readonly PullRequestMetric[];
  deployments: readonly DeploymentMetric[];
  reverts: readonly RevertMetric[];
  incidents: readonly IncidentMetric[];
}

export interface MetricsInput {
  schedule: BusinessSchedule;
  baseline: MetricsWindow;
  current: MetricsWindow;
}

export interface DurationSummary {
  count: number;
  p50: number | null;
  p90: number | null;
}

export interface OperationalMetrics {
  stagingDeploymentCount: number;
  stagingFailureCount: number;
  stagingFailureRate: number | null;
  successfulProductionDeploymentCount: number;
  revertCount: number;
  revertRate: number | null;
  productionIncidentCount: number;
  productionIncidentRate: number | null;
  severeFactoryIncidentCount: number;
}

export interface WindowRepositoryMetrics {
  repository: string;
  pullRequestCount: number;
  firstHumanResponseMinutes: DurationSummary;
  firstApprovalMinutes: DurationSummary;
  readyToMergeMinutes: DurationSummary;
  eligibleToMergedMinutes: DurationSummary;
  specialistRequiredCount: number;
  specialistComplianceRate: number | null;
  mergesByOwnerTeam: Readonly<Record<string, number>>;
  operations: OperationalMetrics;
}

export type GateStatus = "pass" | "fail" | "insufficient-data";

export interface GateEvaluation {
  status: GateStatus;
  observed: number | null;
  baseline?: number | null;
  target?: number | null;
  sampleCount: number;
}

export interface RepositoryGates {
  firstHumanResponseP50: GateEvaluation;
  firstHumanResponseP90: GateEvaluation;
  readyToMergeP50: GateEvaluation;
  eligibleToMergedP90: GateEvaluation;
  specialistCompliance: GateEvaluation;
  stagingFailureRate: GateEvaluation;
  revertRate: GateEvaluation;
  productionIncidentRate: GateEvaluation;
  severeFactoryIncident: GateEvaluation;
}

export interface RepositoryMetrics {
  repository: string;
  baseline: WindowRepositoryMetrics;
  current: WindowRepositoryMetrics;
  gates: RepositoryGates;
}

export interface MetricsReport {
  repositories: readonly RepositoryMetrics[];
}

const minimumSampleSize = 10;
const firstResponseRequiredImprovement = 0.5;
const readyToMergeRequiredImprovement = 0.3;
const eligibleToMergedTargetMinutes = 60;

export function businessMinutesBetween(
  start: string,
  end: string,
  schedule: BusinessSchedule,
): number {
  validateSchedule(schedule);

  const startInstant = parseTimestamp(start, "Start time");
  const endInstant = parseTimestamp(end, "End time");
  if (endInstant < startInstant) {
    throw new Error("End time must not precede start time");
  }

  const offsetMilliseconds = schedule.utcOffsetMinutes * 60_000;
  const localStart = startInstant + offsetMilliseconds;
  const localEnd = endInstant + offsetMilliseconds;
  const firstDay = startOfUtcDay(localStart);
  const lastDay = startOfUtcDay(localEnd);
  const allowedWeekdays = new Set(schedule.weekdays);
  const holidays = new Set(schedule.holidays);
  let businessMilliseconds = 0;

  for (let day = firstDay; day <= lastDay; day += 24 * 60 * 60 * 1_000) {
    const localDate = new Date(day);
    if (
      !allowedWeekdays.has(localDate.getUTCDay()) ||
      holidays.has(formatLocalDate(localDate))
    ) {
      continue;
    }

    const opening = day + schedule.startMinute * 60_000;
    const closing = day + schedule.endMinute * 60_000;
    const overlapStart = Math.max(localStart, opening);
    const overlapEnd = Math.min(localEnd, closing);
    businessMilliseconds += Math.max(0, overlapEnd - overlapStart);
  }

  return businessMilliseconds / 60_000;
}

export function buildMetricsReport(input: MetricsInput): MetricsReport {
  validateSchedule(input.schedule);
  validateWindow(input.baseline, "Baseline");
  validateWindow(input.current, "Current");

  const repositories = collectRepositories(input.baseline, input.current);
  return {
    repositories: repositories.map((repository) => {
      const baseline = summarizeRepository(
        repository,
        input.baseline,
        input.schedule,
      );
      const current = summarizeRepository(
        repository,
        input.current,
        input.schedule,
      );
      return {
        repository,
        baseline,
        current,
        gates: evaluateGates(baseline, current, input.schedule),
      };
    }),
  };
}

function summarizeRepository(
  repository: string,
  window: MetricsWindow,
  schedule: BusinessSchedule,
): WindowRepositoryMetrics {
  const pullRequests = window.pullRequests.filter(
    (record) => record.repository === repository,
  );
  const deployments = window.deployments.filter(
    (deployment) => deployment.repository === repository,
  );
  const productionDeployments = deployments.filter(
    (deployment) =>
      deployment.environment === "production" &&
      deployment.status === "succeeded",
  );
  const productionDeploymentIds = new Set(
    productionDeployments.map((deployment) => deployment.id),
  );
  const stagingDeployments = deployments.filter(
    (deployment) => deployment.environment === "staging",
  );
  const reverts = window.reverts.filter(
    (revert) =>
      revert.repository === repository &&
      productionDeploymentIds.has(revert.deploymentId),
  );
  const productionIncidents = window.incidents.filter(
    (incident) =>
      incident.repository === repository &&
      (incident.deploymentId === undefined ||
        productionDeploymentIds.has(incident.deploymentId)),
  );
  const specialistRecords = pullRequests.filter(
    (record) => record.specialistRequired,
  );
  const mergesByOwnerTeam: Record<string, number> = {};

  for (const record of pullRequests) {
    if (record.mergedAt === undefined || record.mergerTeam === undefined) {
      continue;
    }
    mergesByOwnerTeam[record.mergerTeam] =
      (mergesByOwnerTeam[record.mergerTeam] ?? 0) + 1;
  }

  const stagingFailureCount = stagingDeployments.filter(
    (deployment) => deployment.status === "failed",
  ).length;

  return {
    repository,
    pullRequestCount: pullRequests.length,
    firstHumanResponseMinutes: summarizePullRequestDuration(
      pullRequests,
      "readyAt",
      "firstHumanResponseAt",
      schedule,
    ),
    firstApprovalMinutes: summarizePullRequestDuration(
      pullRequests,
      "readyAt",
      "firstApprovalAt",
      schedule,
    ),
    readyToMergeMinutes: summarizePullRequestDuration(
      pullRequests,
      "readyAt",
      "readyToMergeAt",
      schedule,
    ),
    eligibleToMergedMinutes: summarizePullRequestDuration(
      pullRequests,
      "eligibleAt",
      "mergedAt",
      schedule,
    ),
    specialistRequiredCount: specialistRecords.length,
    specialistComplianceRate:
      specialistRecords.length === 0
        ? null
        : specialistRecords.filter((record) => record.specialistSatisfied)
            .length / specialistRecords.length,
    mergesByOwnerTeam: sortRecord(mergesByOwnerTeam),
    operations: {
      stagingDeploymentCount: stagingDeployments.length,
      stagingFailureCount,
      stagingFailureRate: rate(stagingFailureCount, stagingDeployments.length),
      successfulProductionDeploymentCount: productionDeployments.length,
      revertCount: reverts.length,
      revertRate: rate(reverts.length, productionDeployments.length),
      productionIncidentCount: productionIncidents.length,
      productionIncidentRate: rate(
        productionIncidents.length,
        productionDeployments.length,
      ),
      severeFactoryIncidentCount: window.incidents.filter(
        (incident) =>
          incident.repository === repository &&
          incident.factoryCaused &&
          (incident.severity === "Sev1" || incident.severity === "Sev2"),
      ).length,
    },
  };
}

function evaluateGates(
  baseline: WindowRepositoryMetrics,
  current: WindowRepositoryMetrics,
  schedule: BusinessSchedule,
): RepositoryGates {
  return {
    firstHumanResponseP50: improvementGate(
      baseline.firstHumanResponseMinutes.p50,
      baseline.firstHumanResponseMinutes.count,
      current.firstHumanResponseMinutes.p50,
      current.firstHumanResponseMinutes.count,
      firstResponseRequiredImprovement,
    ),
    firstHumanResponseP90: maximumGate(
      current.firstHumanResponseMinutes.p90,
      current.firstHumanResponseMinutes.count,
      schedule.endMinute - schedule.startMinute,
      false,
    ),
    readyToMergeP50: improvementGate(
      baseline.readyToMergeMinutes.p50,
      baseline.readyToMergeMinutes.count,
      current.readyToMergeMinutes.p50,
      current.readyToMergeMinutes.count,
      readyToMergeRequiredImprovement,
    ),
    eligibleToMergedP90: maximumGate(
      current.eligibleToMergedMinutes.p90,
      current.eligibleToMergedMinutes.count,
      eligibleToMergedTargetMinutes,
      true,
    ),
    specialistCompliance: exactGate(
      current.specialistComplianceRate,
      current.specialistRequiredCount,
      1,
    ),
    stagingFailureRate: nonRegressionGate(
      baseline.operations.stagingFailureRate,
      baseline.operations.stagingDeploymentCount,
      current.operations.stagingFailureRate,
      current.operations.stagingDeploymentCount,
    ),
    revertRate: nonRegressionGate(
      baseline.operations.revertRate,
      baseline.operations.successfulProductionDeploymentCount,
      current.operations.revertRate,
      current.operations.successfulProductionDeploymentCount,
    ),
    productionIncidentRate: nonRegressionGate(
      baseline.operations.productionIncidentRate,
      baseline.operations.successfulProductionDeploymentCount,
      current.operations.productionIncidentRate,
      current.operations.successfulProductionDeploymentCount,
    ),
    severeFactoryIncident: {
      status:
        current.operations.severeFactoryIncidentCount === 0 ? "pass" : "fail",
      observed: current.operations.severeFactoryIncidentCount,
      target: 0,
      sampleCount: current.operations.severeFactoryIncidentCount,
    },
  };
}

function improvementGate(
  baseline: number | null,
  baselineCount: number,
  current: number | null,
  currentCount: number,
  requiredImprovement: number,
): GateEvaluation {
  const target = baseline === null ? null : baseline * (1 - requiredImprovement);
  if (
    baseline === null ||
    baseline <= 0 ||
    current === null ||
    baselineCount < minimumSampleSize ||
    currentCount < minimumSampleSize
  ) {
    return {
      status: "insufficient-data",
      observed: current,
      baseline,
      target,
      sampleCount: currentCount,
    };
  }
  const establishedTarget = baseline * (1 - requiredImprovement);
  return {
    status: current <= establishedTarget ? "pass" : "fail",
    observed: current,
    baseline,
    target: establishedTarget,
    sampleCount: currentCount,
  };
}

function maximumGate(
  observed: number | null,
  sampleCount: number,
  target: number,
  inclusive: boolean,
): GateEvaluation {
  if (observed === null || sampleCount < minimumSampleSize) {
    return { status: "insufficient-data", observed, target, sampleCount };
  }
  const passes = inclusive ? observed <= target : observed < target;
  return {
    status: passes ? "pass" : "fail",
    observed,
    target,
    sampleCount,
  };
}

function exactGate(
  observed: number | null,
  sampleCount: number,
  target: number,
): GateEvaluation {
  if (observed === null || sampleCount < minimumSampleSize) {
    return { status: "insufficient-data", observed, target, sampleCount };
  }
  return {
    status: observed === target ? "pass" : "fail",
    observed,
    target,
    sampleCount,
  };
}

function nonRegressionGate(
  baseline: number | null,
  baselineCount: number,
  current: number | null,
  currentCount: number,
): GateEvaluation {
  if (
    baseline === null ||
    current === null ||
    baselineCount < minimumSampleSize ||
    currentCount < minimumSampleSize
  ) {
    return {
      status: "insufficient-data",
      observed: current,
      baseline,
      sampleCount: currentCount,
    };
  }
  return {
    status: current <= baseline ? "pass" : "fail",
    observed: current,
    baseline,
    sampleCount: currentCount,
  };
}

function summarizePullRequestDuration(
  records: readonly PullRequestMetric[],
  startField: "readyAt" | "eligibleAt",
  endField:
    | "firstHumanResponseAt"
    | "firstApprovalAt"
    | "readyToMergeAt"
    | "mergedAt",
  schedule: BusinessSchedule,
): DurationSummary {
  const durations = records.flatMap((record) => {
    const start = record[startField];
    const end = record[endField];
    return start === undefined || end === undefined
      ? []
      : [businessMinutesBetween(start, end, schedule)];
  });
  return summarizeDurations(durations);
}

function summarizeDurations(durations: readonly number[]): DurationSummary {
  return {
    count: durations.length,
    p50: percentile(durations, 0.5),
    p90: percentile(durations, 0.9),
  };
}

function percentile(values: readonly number[], percentileRank: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentileRank;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("Unable to calculate percentile");
  }

  const interpolated = lower + (upper - lower) * (position - lowerIndex);
  return Math.round(interpolated * 100) / 100;
}

function collectRepositories(
  baseline: MetricsWindow,
  current: MetricsWindow,
): string[] {
  const repositories = new Set<string>();
  for (const window of [baseline, current]) {
    for (const record of [
      ...window.pullRequests,
      ...window.deployments,
      ...window.reverts,
      ...window.incidents,
    ]) {
      repositories.add(record.repository);
    }
  }
  return [...repositories].sort((left, right) => left.localeCompare(right));
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function validateWindow(window: MetricsWindow, label: string): void {
  const startsAt = parseTimestamp(window.startsAt, `${label} start`);
  const endsAt = parseTimestamp(window.endsAt, `${label} end`);
  if (endsAt <= startsAt) {
    throw new Error(`${label} window end must follow its start`);
  }
}

function validateSchedule(schedule: BusinessSchedule): void {
  if (
    !Number.isInteger(schedule.utcOffsetMinutes) ||
    schedule.utcOffsetMinutes < -14 * 60 ||
    schedule.utcOffsetMinutes > 14 * 60
  ) {
    throw new Error("UTC offset must be an integer between -840 and 840 minutes");
  }
  if (
    !Number.isInteger(schedule.startMinute) ||
    !Number.isInteger(schedule.endMinute) ||
    schedule.startMinute < 0 ||
    schedule.endMinute > 24 * 60 ||
    schedule.startMinute >= schedule.endMinute
  ) {
    throw new Error("Business hours must be a valid increasing minute range");
  }

  const weekdays = new Set(schedule.weekdays);
  if (
    weekdays.size !== schedule.weekdays.length ||
    [...weekdays].some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error("Weekdays must be unique integers from 0 through 6");
  }
  if (schedule.holidays.some((holiday) => !/^\d{4}-\d{2}-\d{2}$/.test(holiday))) {
    throw new Error("Holidays must use YYYY-MM-DD format");
  }
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp`);
  }
  return timestamp;
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function formatLocalDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sortRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
