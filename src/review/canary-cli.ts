import { parseArgs } from "node:util";

import type { CanaryAttestation } from "./canary-evaluator.ts";
import { evaluateRepositoryCanary, selectCanaries } from "./canary-run.ts";
import { GitHubRestAdapter } from "./github-rest-adapter.ts";
import { resolveGitHubToken } from "./github-token.ts";
import { loadFactoryReviewPolicies } from "./policy-loader.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean" },
    "credential-incidents": { type: "string" },
    "unsafe-reviews": { type: "string" },
    "human-approval-intact": { type: "boolean" },
  },
});

try {
  const all = values.all === true;
  const repositoryId = positionals[0];
  if (all === (repositoryId !== undefined)) {
    throw new Error(
      "Usage: pnpm review:evaluate <repository-id> | --all [attestation flags]",
    );
  }
  const now = new Date();
  const attested = attestation();
  const { bundle, policy } = await loadFactoryReviewPolicies(now);
  const canaries = selectCanaries(bundle.repositories, policy.repositories, repositoryId);
  const github = new GitHubRestAdapter({
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    token: await resolveGitHubToken(),
  });
  const reports = await Promise.all(
    canaries.map(async (canary) => ({
      repository: canary.review.id,
      ...(await evaluateRepositoryCanary({
        github,
        canary,
        criteria: policy.canary,
        attestation: attested,
        now,
      })),
    })),
  );
  process.stdout.write(`${JSON.stringify(all ? reports : reports[0], null, 2)}\n`);
  process.exitCode = reports.every((report) => report.decidable && report.passed) ? 0 : 1;
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
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
