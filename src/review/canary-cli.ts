import { parseArgs } from "node:util";

import { parseExternalId } from "./check-run.ts";
import {
  evaluateCanary,
  type CanaryAttestation,
  type CanaryRecord,
} from "./canary-evaluator.ts";
import {
  GitHubRestAdapter,
  type SuccessfulPullRequestRun,
} from "./github-rest-adapter.ts";
import { loadRepositoryReview } from "./policy-loader.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "credential-incidents": { type: "string" },
    "unsafe-reviews": { type: "string" },
    "human-approval-intact": { type: "boolean" },
  },
});

try {
  const repositoryId = positionals[0];
  if (repositoryId === undefined) {
    throw new Error("Usage: pnpm review:evaluate <repository-id> [attestation flags]");
  }
  const now = new Date();
  const { repository, review, policy } = await loadRepositoryReview(
    (entry) => entry.id === repositoryId,
    now,
  );
  if (review.mode === "disabled" || review.canaryStartsAt === undefined) {
    throw new Error(`Repository "${repositoryId}" has no active canary`);
  }
  const github = new GitHubRestAdapter({
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    token: requiredEnvironment("GITHUB_TOKEN"),
  });
  const runs = await github.listSuccessfulPullRequestRuns(
    repository.github,
    review.ciWorkflowName,
    review.canaryStartsAt,
  );
  const records = await Promise.all(
    earliestRunPerHead(runs, repository.github).map(
      async (run): Promise<CanaryRecord> => {
        const pullRequestNumber = run.pullRequestNumbers[0] ?? 0;
        const [checks, labels] = await Promise.all([
          github.listFactoryCheckRuns(repository.github, run.headSha),
          github.listPullRequestLabels(repository.github, pullRequestNumber),
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
  const report = evaluateCanary({
    records,
    attestation: attestation(),
    criteria: policy.canary,
    startsAt: review.canaryStartsAt,
    now,
  });
  process.stdout.write(`${JSON.stringify({ repository: repositoryId, ...report }, null, 2)}\n`);
  process.exitCode = report.decidable && report.passed ? 0 : 1;
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
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

function attestation(): CanaryAttestation {
  return {
    credentialIncidents: attestedCount(values["credential-incidents"]),
    unsafeReviews: attestedCount(values["unsafe-reviews"]),
    humanApprovalIntact: values["human-approval-intact"] === true ? true : null,
  };
}

function attestedCount(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Attestation count must be a non-negative integer, got "${value}"`);
  }
  return count;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment value: ${name}`);
  }
  return value;
}
