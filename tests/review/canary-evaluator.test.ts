import { describe, expect, test } from "vitest";

import {
  evaluateCanary,
  type CanaryAttestation,
  type CanaryCriteria,
  type CanaryRecord,
  type CanaryReport,
} from "../../src/review/index.js";

const criteria: CanaryCriteria = {
  minimumPullRequests: 10,
  maxDays: 14,
  maxFalsePositives: 1,
  maxTechnicalErrorRate: 0.05,
  maxP95LatencyMinutes: 10,
};

const startsAt = "2026-10-25T09:00:00Z";
const dayMs = 24 * 60 * 60 * 1_000;
const minuteMs = 60 * 1_000;
const dayFive = new Date(Date.parse(startsAt) + 5 * dayMs);
const dayFourteen = new Date(Date.parse(startsAt) + 14 * dayMs);

const attested: CanaryAttestation = {
  credentialIncidents: 0,
  unsafeReviews: 0,
  humanApprovalIntact: true,
};

function at(offsetMs: number): string {
  return new Date(Date.parse(startsAt) + offsetMs).toISOString();
}

function record(index: number, overrides: Partial<CanaryRecord> = {}): CanaryRecord {
  const ciOffset = (index + 1) * 60 * minuteMs;
  return {
    pullRequestNumber: index + 1,
    headSha: `sha-${index}`,
    ciCompletedAt: at(ciOffset),
    checks: [{ outcome: "clean", completedAt: at(ciOffset + 3 * minuteMs) }],
    labels: [],
    ...overrides,
  };
}

function healthy(count: number): CanaryRecord[] {
  return Array.from({ length: count }, (_, index) => record(index));
}

function evaluate(
  records: CanaryRecord[],
  options: { now?: Date; attestation?: CanaryAttestation } = {},
): CanaryReport {
  return evaluateCanary({
    records,
    attestation: options.attestation ?? attested,
    criteria,
    startsAt,
    now: options.now ?? dayFive,
  });
}

function result(report: CanaryReport, name: string) {
  const match = report.results.find((entry) => entry.name === name);
  expect(match, `missing result ${name}`).toBeDefined();
  return match;
}

describe("evaluateCanary", () => {
  test("passes a fully healthy ten-PR canary", () => {
    const report = evaluate(healthy(10));

    expect(report).toMatchObject({ decidable: true, passed: true, sample: 10 });
    expect(report.results.every((entry) => entry.passed)).toBe(true);
  });

  test("is not decidable with nine PRs on day five", () => {
    expect(evaluate(healthy(9))).toMatchObject({
      decidable: false,
      passed: false,
      reason: "insufficient evidence",
    });
  });

  test("becomes decidable at day fourteen with fewer PRs", () => {
    expect(evaluate(healthy(4), { now: dayFourteen })).toMatchObject({
      decidable: true,
      passed: true,
      windowEndsAt: dayFourteen.toISOString(),
    });
  });

  test("never promotes a canary that reviewed nothing", () => {
    const report = evaluate([], { now: dayFourteen });

    expect(report.passed).toBe(false);
    expect(result(report, "reviewed-pull-requests")?.passed).toBe(false);
  });

  test("ignores CI runs outside the canary window", () => {
    const report = evaluate([
      ...healthy(10),
      record(20, { ciCompletedAt: at(-minuteMs) }),
      record(21, { ciCompletedAt: at(14 * dayMs) }),
    ]);

    expect(report.sample).toBe(10);
  });

  test("reports heads that CI passed but the factory never checked", () => {
    expect(
      evaluate([...healthy(10), record(30, { checks: [] })]).unreviewedHeads,
    ).toBe(1);
  });

  test("counts pull requests, not head commits, toward the sample", () => {
    const tenPushesToOnePullRequest = healthy(10).map((entry) => ({
      ...entry,
      pullRequestNumber: 1,
    }));

    expect(evaluate(tenPushesToOnePullRequest)).toMatchObject({
      decidable: false,
      sample: 1,
    });
  });

  test("does not count heads without a decisive review as reviewed", () => {
    const undecided = [
      record(40, { checks: [{ outcome: "missing-purpose", completedAt: at(minuteMs) }] }),
      record(41, { checks: [{ outcome: "technical", completedAt: at(minuteMs) }] }),
      record(42, { checks: [{ outcome: "fork", completedAt: at(minuteMs) }] }),
    ];

    expect(evaluate([...healthy(9), ...undecided])).toMatchObject({
      decidable: false,
      sample: 9,
      unreviewedHeads: 3,
    });
  });

  test("counts a false-positive verdict once per pull request across its heads", () => {
    const labeledHead = (index: number) =>
      record(index, {
        pullRequestNumber: 1,
        checks: [{ outcome: "findings", completedAt: at((index + 1) * 60 * minuteMs + minuteMs) }],
        labels: ["factory-review:false-positive"],
      });
    const records = [labeledHead(0), labeledHead(1), ...healthy(11).slice(2)];

    expect(result(evaluate(records), "false-positives")).toMatchObject({
      value: 1,
      passed: true,
    });
  });

  test("fails a head with more than one decisive review", () => {
    const records = healthy(10);
    records[0] = record(0, {
      checks: [
        { outcome: "findings", completedAt: at(70 * minuteMs) },
        { outcome: "clean", completedAt: at(80 * minuteMs) },
      ],
      labels: ["factory-review:valid"],
    });

    expect(result(evaluate(records), "duplicate-reviews")).toMatchObject({
      value: 1,
      passed: false,
    });
  });

  test("requires a disposition label on every finding-bearing PR", () => {
    const findings = { checks: [{ outcome: "findings" as const, completedAt: at(70 * minuteMs) }] };
    const unlabeled = [record(0, findings), ...healthy(10).slice(1)];
    const labeled = [record(0, { ...findings, labels: ["factory-review:valid"] }), ...healthy(10).slice(1)];

    expect(result(evaluate(unlabeled), "unlabeled-findings")?.passed).toBe(false);
    expect(result(evaluate(labeled), "unlabeled-findings")?.passed).toBe(true);
  });

  test("allows at most one false-positive verdict", () => {
    const falsePositive = (index: number) =>
      record(index, {
        checks: [{ outcome: "findings", completedAt: at((index + 1) * 60 * minuteMs + minuteMs) }],
        labels: ["factory-review:false-positive"],
      });

    expect(
      result(evaluate([falsePositive(0), ...healthy(10).slice(1)]), "false-positives")?.passed,
    ).toBe(true);
    expect(
      result(
        evaluate([falsePositive(0), falsePositive(1), ...healthy(10).slice(2)]),
        "false-positives",
      ),
    ).toMatchObject({ value: 2, passed: false });
  });

  test("fails when post-retry technical errors exceed five percent", () => {
    const records = healthy(10);
    records[0] = record(0, {
      checks: [
        { outcome: "technical", completedAt: at(61 * minuteMs) },
        { outcome: "clean", completedAt: at(65 * minuteMs) },
      ],
    });

    expect(result(evaluate(records), "technical-error-rate")).toMatchObject({
      value: 1 / 11,
      passed: false,
    });
  });

  test("fails when p95 latency from CI to decision exceeds ten minutes", () => {
    const records = healthy(10);
    records[9] = record(9, {
      checks: [{ outcome: "clean", completedAt: at(10 * 60 * minuteMs + 30 * minuteMs) }],
    });

    expect(result(evaluate(records), "p95-latency-minutes")).toMatchObject({
      value: 30,
      passed: false,
    });
  });

  test("fails every safety attestation that nobody made", () => {
    const report = evaluate(healthy(10), {
      attestation: { credentialIncidents: null, unsafeReviews: null, humanApprovalIntact: null },
    });

    expect(report.passed).toBe(false);
    for (const name of ["credential-incidents", "unsafe-reviews", "human-approval-intact"]) {
      expect(result(report, name)?.passed).toBe(false);
    }
  });
});
