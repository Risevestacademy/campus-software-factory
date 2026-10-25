import { parse as parseYaml } from "yaml";

import { createJsonParser } from "../schema/index.ts";
import type { ProviderId } from "./contracts.ts";

export type ReviewMode = "disabled" | "advisory" | "enforced";

export interface ReviewCredential {
  secret: string;
  ownership: "organization" | "personal";
  owner?: string;
  expiresOn?: string;
  rotateBy?: string;
}

export interface ReviewProvider {
  id: ProviderId;
  model: string;
}

export interface RepositoryReviewPolicy {
  id: string;
  mode: ReviewMode;
  ciWorkflowName: string;
  targetBranches: ("dev" | "main")[];
  provider: ReviewProvider;
  canaryStartsAt?: string;
  canaryProvider?: ReviewProvider;
  credential?: ReviewCredential;
}

export interface CanaryCriteria {
  minimumPullRequests: number;
  maxDays: number;
  maxFalsePositives: number;
  maxTechnicalErrorRate: number;
  maxP95LatencyMinutes: number;
}

export interface PrReviewPolicy {
  version: 1;
  checkName: "Factory PR Review";
  rubric: { version: 1; maxFindings: 3; minimumConfidence: 0.9 };
  canary: CanaryCriteria;
  repositories: RepositoryReviewPolicy[];
}

// The caller template passes these exact secrets, so policy may name no other.
export const providerCredentialSecrets: Readonly<Record<ProviderId, string>> = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "OPENAI_API_KEY",
};

const validatePrReviewPolicy = createJsonParser<PrReviewPolicy>(
  new URL("../../policies/schema/pr-review.schema.json", import.meta.url),
  "PR review policy",
);

export function parsePrReviewPolicy(
  source: string,
  registryIds: readonly string[],
  now: Date,
): PrReviewPolicy {
  const policy = validatePrReviewPolicy(parseDocument(source));
  const knownIds = new Set(registryIds);
  const seenIds = new Set<string>();

  for (const repository of policy.repositories) {
    if (!knownIds.has(repository.id)) {
      throw new Error(
        `Review policy repository "${repository.id}" is not in the repository registry`,
      );
    }
    if (seenIds.has(repository.id)) {
      throw new Error(`Duplicate review policy repository "${repository.id}"`);
    }
    seenIds.add(repository.id);
    validateCanaryStart(repository);
    validateCanaryProvider(repository);
    validateCredentialSecret(repository);
    validateCredentialDates(repository, now);
  }
  return policy;
}

function parseDocument(source: string): unknown {
  try {
    return parseYaml(source) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PR review policy: ${message}`, { cause: error });
  }
}

function validateCanaryStart(repository: RepositoryReviewPolicy): void {
  if (
    repository.canaryStartsAt !== undefined &&
    Number.isNaN(Date.parse(repository.canaryStartsAt))
  ) {
    throw new Error(`Repository "${repository.id}" canaryStartsAt is not a valid time`);
  }
}

// Canary evidence qualifies one provider and model; any change must restart it.
function validateCanaryProvider(repository: RepositoryReviewPolicy): void {
  const { provider, canaryProvider } = repository;
  if (
    canaryProvider !== undefined &&
    (canaryProvider.id !== provider.id || canaryProvider.model !== provider.model)
  ) {
    throw new Error(
      `Repository "${repository.id}" provider ${describeProvider(provider)} differs from its canary ${describeProvider(canaryProvider)}; start a new canary`,
    );
  }
}

function describeProvider(provider: ReviewProvider): string {
  return `${provider.id}/${provider.model}`;
}

function validateCredentialSecret(repository: RepositoryReviewPolicy): void {
  const secret = repository.credential?.secret;
  const expected = providerCredentialSecrets[repository.provider.id];
  if (secret !== undefined && secret !== expected) {
    throw new Error(
      `Repository "${repository.id}" credential secret ${secret} must be ${expected} for provider ${repository.provider.id}`,
    );
  }
}

function validateCredentialDates(
  repository: RepositoryReviewPolicy,
  now: Date,
): void {
  const credential = repository.credential;
  if (credential?.expiresOn === undefined || credential.rotateBy === undefined) {
    return;
  }
  const expiresAt = parseDate(credential.expiresOn, repository.id, "expiresOn");
  const rotateAt = parseDate(credential.rotateBy, repository.id, "rotateBy");
  if (rotateAt > expiresAt) {
    throw new Error(
      `Repository "${repository.id}" credential rotateBy must not be after expiresOn`,
    );
  }
  if (now.getTime() >= expiresAt) {
    throw new Error(
      `Repository "${repository.id}" credential expired on ${credential.expiresOn}`,
    );
  }
}

function parseDate(value: string, repositoryId: string, field: string): number {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time)) {
    throw new Error(`Repository "${repositoryId}" credential ${field} is not a valid date`);
  }
  return time;
}
