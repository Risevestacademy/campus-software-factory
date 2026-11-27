import type { RepositoryPolicy } from "../policy/index.ts";
import { parseExternalId } from "./check-run.ts";
import {
  evaluateCanary,
  type CanaryAttestation,
  type CanaryRecord,
  type CanaryReport,
} from "./canary-evaluator.ts";
import type {
  GitHubRestAdapter,
  SuccessfulPullRequestRun,
} from "./github-rest-adapter.ts";
import type { CanaryCriteria, RepositoryReviewPolicy } from "./provider-policy.ts";

export type CanaryGitHub = Pick<
  GitHubRestAdapter,
  "listSuccessfulPullRequestRuns" | "listFactoryCheckRuns" | "listPullRequestLabels"
>;

export interface ActiveCanary {
  githubRepository: string;
  review: RepositoryReviewPolicy;
  startsAt: string;
}

export function selectCanaries(
  repositories: readonly RepositoryPolicy[],
  reviews: readonly RepositoryReviewPolicy[],
  repositoryId?: string,
): ActiveCanary[] {
  const active = reviews.flatMap((review) => {
    const repository = repositories.find((entry) => entry.id === review.id);
    return repository !== undefined &&
      review.mode !== "disabled" &&
      review.canaryStartsAt !== undefined
      ? [{ githubRepository: repository.github, review, startsAt: review.canaryStartsAt }]
      : [];
  });
  const selected =
    repositoryId === undefined
      ? active
      : active.filter((canary) => canary.review.id === repositoryId);
  if (selected.length === 0) {
    throw new Error(
      repositoryId === undefined
        ? "No repository has an active canary"
        : `Repository "${repositoryId}" has no active canary`,
    );
  }
  return selected;
}

export async function evaluateRepositoryCanary(input: {
  github: CanaryGitHub;
  canary: ActiveCanary;
  criteria: CanaryCriteria;
  attestation: CanaryAttestation;
  now: Date;
}): Promise<CanaryReport> {
  return evaluateCanary({
    records: await collectCanaryRecords(input.github, input.canary),
    attestation: input.attestation,
    criteria: input.criteria,
    startsAt: input.canary.startsAt,
    now: input.now,
  });
}

export async function collectCanaryRecords(
  github: CanaryGitHub,
  canary: ActiveCanary,
): Promise<CanaryRecord[]> {
  const runs = await github.listSuccessfulPullRequestRuns(
    canary.githubRepository,
    canary.review.ciWorkflowName,
    canary.startsAt,
  );
  return Promise.all(
    earliestRunPerHead(runs, canary.githubRepository).map(
      async (run): Promise<CanaryRecord> => {
        const pullRequestNumber = run.pullRequestNumbers[0] ?? 0;
        const [checks, labels] = await Promise.all([
          github.listFactoryCheckRuns(canary.githubRepository, run.headSha),
          github.listPullRequestLabels(canary.githubRepository, pullRequestNumber),
        ]);
        return {
          pullRequestNumber,
          headSha: run.headSha,
          ciCompletedAt: run.completedAt,
          checks: checks.flatMap((check) => {
            const parsed = parseExternalId(check.externalId);
            return check.status === "completed" && parsed !== null
              ? [{ outcome: parsed.outcome, completedAt: check.completedAt }]
              : [];
          }),
          labels,
        };
      },
    ),
  );
}

function earliestRunPerHead(
  runs: readonly SuccessfulPullRequestRun[],
  githubRepository: string,
): SuccessfulPullRequestRun[] {
  const byHead = new Map<string, SuccessfulPullRequestRun>();
  for (const run of runs) {
    if (run.headRepository !== githubRepository || run.pullRequestNumbers.length !== 1) {
      continue;
    }
    const existing = byHead.get(run.headSha);
    if (existing === undefined || run.completedAt < existing.completedAt) {
      byHead.set(run.headSha, run);
    }
  }
  return [...byHead.values()];
}
