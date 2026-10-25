import { readFile } from "node:fs/promises";

import {
  parsePolicyDocuments,
  type FactoryPolicyBundle,
  type RepositoryPolicy,
} from "../policy/index.ts";
import {
  parsePrReviewPolicy,
  type PrReviewPolicy,
  type RepositoryReviewPolicy,
} from "./provider-policy.ts";

export interface LoadedRepositoryReview {
  repository: RepositoryPolicy;
  review: RepositoryReviewPolicy;
  policy: PrReviewPolicy;
}

export interface FactoryReviewPolicies {
  bundle: FactoryPolicyBundle;
  policy: PrReviewPolicy;
}

// Reads the factory's own committed policy files, never the reviewed pull request.
export async function loadFactoryReviewPolicies(now: Date): Promise<FactoryReviewPolicies> {
  const factoryRoot = new URL("../../", import.meta.url);
  const [registrySource, sensitivePathsSource, prReviewSource] = await Promise.all([
    readFile(new URL("policies/repo-registry.yaml", factoryRoot), "utf8"),
    readFile(new URL("policies/sensitive-paths.yaml", factoryRoot), "utf8"),
    readFile(new URL("policies/pr-review.yaml", factoryRoot), "utf8"),
  ]);
  const bundle = parsePolicyDocuments(registrySource, sensitivePathsSource);
  const policy = parsePrReviewPolicy(
    prReviewSource,
    bundle.repositories.map((entry) => entry.id),
    now,
  );
  return { bundle, policy };
}

export async function loadRepositoryReview(
  match: (repository: RepositoryPolicy) => boolean,
  now: Date,
): Promise<LoadedRepositoryReview> {
  const { bundle, policy } = await loadFactoryReviewPolicies(now);
  const repository = bundle.repositories.find(match);
  const review = policy.repositories.find((entry) => entry.id === repository?.id);
  if (repository === undefined || review === undefined) {
    throw new Error("No PR review policy for the requested repository");
  }
  return { repository, review, policy };
}
