import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parsePrReviewPolicy } from "../review/provider-policy.ts";
import { parsePolicyDocuments } from "./index.js";

const repositoryRegistryPath = resolve(
  process.argv[2] ?? "policies/repo-registry.yaml",
);
const sensitivePathsPath = resolve(
  process.argv[3] ?? "policies/sensitive-paths.yaml",
);
const prReviewPath = resolve(process.argv[4] ?? "policies/pr-review.yaml");

try {
  const [repositoryRegistry, sensitivePaths, prReview] = await Promise.all([
    readFile(repositoryRegistryPath, "utf8"),
    readFile(sensitivePathsPath, "utf8"),
    readFile(prReviewPath, "utf8"),
  ]);
  const policy = parsePolicyDocuments(repositoryRegistry, sensitivePaths);
  const review = parsePrReviewPolicy(
    prReview,
    policy.repositories.map((repository) => repository.id),
    new Date(),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        repositories: policy.repositories.length,
        mechanicalRules: policy.paths.mechanicalAllowlist.length,
        sensitiveRules: policy.paths.sensitivePaths.length,
        reviewRepositories: review.repositories.length,
      },
      null,
      2,
    )}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
