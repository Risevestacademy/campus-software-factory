import { describe, expect, test } from "vitest";

import {
  buildMetricsReport,
  businessMinutesBetween,
  type BusinessSchedule,
  type MetricsWindow,
  type PullRequestMetric,
} from "../../src/metrics/index.js";

const lagosSchedule: BusinessSchedule = {
  utcOffsetMinutes: 60,
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  holidays: ["2026-10-19"],
};

describe("businessMinutesBetween", () => {
  test("excludes Lagos off-hours, weekends, and published holidays", () => {
    expect(
      businessMinutesBetween(
        "2026-10-16T15:00:00.000Z",
        "2026-10-20T09:00:00.000Z",
        lagosSchedule,
      ),
    ).toBe(120);
  });

  test("rejects an end time before the start time", () => {
    expect(() =>
      businessMinutesBetween(
        "2026-10-20T09:00:00.000Z",
        "2026-10-20T08:00:00.000Z",
        lagosSchedule,
      ),
    ).toThrow("End time must not precede start time");
  });
});

describe("buildMetricsReport", () => {
  test("evaluates flow, specialist, and operational gates against a baseline", () => {
    const baseline = buildWindow({
      responseMinutes: 120,
      readyToMergeMinutes: 100,
      eligibleToMergedMinutes: 45,
      stagingFailures: 2,
      reverts: 2,
      incidents: 1,
    });
    const current = buildWindow({
      responseMinutes: 50,
      readyToMergeMinutes: 60,
      eligibleToMergedMinutes: 30,
      stagingFailures: 1,
      reverts: 1,
      incidents: 0,
    });

    const report = buildMetricsReport({
      schedule: lagosSchedule,
      baseline,
      current,
    });

    expect(report.repositories[0]?.current.firstApprovalMinutes).toEqual({
      count: 10,
      p50: 30,
      p90: 30,
    });
    expect(report.repositories[0]?.current.readyToMergeMinutes.p50).toBe(60);
    expect(report.repositories[0]?.gates).toMatchObject({
      firstHumanResponseP50: { status: "pass" },
      firstHumanResponseP90: { status: "pass" },
      readyToMergeP50: { status: "pass" },
      eligibleToMergedP90: { status: "pass" },
      specialistCompliance: { status: "pass" },
      stagingFailureRate: { status: "pass" },
      revertRate: { status: "pass" },
      productionIncidentRate: { status: "pass" },
      severeFactoryIncident: { status: "pass" },
    });
  });

  test("does not present a small improvement sample as established", () => {
    const baseline = buildWindow({ sampleSize: 9, responseMinutes: 120 });
    const current = buildWindow({ sampleSize: 9, responseMinutes: 30 });

    const report = buildMetricsReport({
      schedule: lagosSchedule,
      baseline,
      current,
    });

    expect(
      report.repositories[0]?.gates.firstHumanResponseP50.status,
    ).toBe("insufficient-data");
  });

  test("fails immediately for a factory-caused Sev1 or Sev2 incident", () => {
    const report = buildMetricsReport({
      schedule: lagosSchedule,
      baseline: buildWindow({}),
      current: buildWindow({ severeFactoryIncident: true }),
    });

    expect(
      report.repositories[0]?.gates.severeFactoryIncident.status,
    ).toBe("fail");
  });
});

interface WindowOptions {
  sampleSize?: number;
  responseMinutes?: number;
  readyToMergeMinutes?: number;
  eligibleToMergedMinutes?: number;
  stagingFailures?: number;
  reverts?: number;
  incidents?: number;
  severeFactoryIncident?: boolean;
}

function buildWindow(options: WindowOptions): MetricsWindow {
  const sampleSize = options.sampleSize ?? 10;
  const responseMinutes = options.responseMinutes ?? 60;
  const readyToMergeMinutes = options.readyToMergeMinutes ?? 60;
  const eligibleToMergedMinutes = options.eligibleToMergedMinutes ?? 30;
  const pullRequests = Array.from({ length: sampleSize }, (_, index) =>
    buildPullRequest(
      index,
      responseMinutes,
      readyToMergeMinutes,
      eligibleToMergedMinutes,
    ),
  );
  const deployments = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `staging-${index}`,
      repository: "campus-web",
      environment: "staging" as const,
      status:
        index < (options.stagingFailures ?? 0)
          ? ("failed" as const)
          : ("succeeded" as const),
      completedAt: "2026-10-20T15:00:00.000Z",
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `production-${index}`,
      repository: "campus-web",
      environment: "production" as const,
      status: "succeeded" as const,
      completedAt: "2026-10-20T16:00:00.000Z",
    })),
  ];

  return {
    startsAt: "2026-10-20T00:00:00.000Z",
    endsAt: "2026-10-21T00:00:00.000Z",
    pullRequests,
    deployments,
    reverts: Array.from({ length: options.reverts ?? 0 }, (_, index) => ({
      repository: "campus-web",
      deploymentId: `production-${index}`,
      occurredAt: "2026-10-20T17:00:00.000Z",
    })),
    incidents: [
      ...Array.from({ length: options.incidents ?? 0 }, (_, index) => ({
        repository: "campus-web",
        deploymentId: `production-${index}`,
        severity: "Sev3" as const,
        factoryCaused: false,
        openedAt: "2026-10-20T18:00:00.000Z",
      })),
      ...(options.severeFactoryIncident
        ? [
            {
              repository: "campus-web",
              deploymentId: "production-0",
              severity: "Sev1" as const,
              factoryCaused: true,
              openedAt: "2026-10-20T18:00:00.000Z",
            },
          ]
        : []),
    ],
  };
}

function buildPullRequest(
  index: number,
  responseMinutes: number,
  readyToMergeMinutes: number,
  eligibleToMergedMinutes: number,
): PullRequestMetric {
  const readyAt = new Date(Date.UTC(2026, 9, 20, 8, index)).toISOString();
  return {
    repository: "campus-web",
    readyAt,
    firstHumanResponseAt: addMinutes(readyAt, responseMinutes),
    firstApprovalAt: addMinutes(readyAt, 30),
    readyToMergeAt: addMinutes(readyAt, readyToMergeMinutes),
    eligibleAt: addMinutes(readyAt, readyToMergeMinutes),
    mergedAt: addMinutes(
      readyAt,
      readyToMergeMinutes + eligibleToMergedMinutes,
    ),
    mergerTeam: "campus-web",
    specialistRequired: true,
    specialistSatisfied: true,
  };
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}
