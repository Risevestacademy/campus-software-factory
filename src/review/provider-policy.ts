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

export type ReviewReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ReviewProvider {
  id: ProviderId;
  model: string;
  effort?: ReviewReasoningEffort;
}

export interface UsageLimitFallback {
  provider: ReviewProvider;
  canaryProvider: ReviewProvider;
  credential: ReviewCredential;
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
  usageLimitFallback?: UsageLimitFallback;
}

export interface CanaryCriteria {
  minimumPullRequests: number;
  maxDays: number;
  maxFalsePositives: number;
  maxTechnicalErrorRate: number;
  maxP95LatencyMinutes: number;
}

export interface ReviewSizeLimit {
  maxChangedLines: number;
  maxChangedFiles: number;
  excludedPaths: string[];
}

export interface PrReviewPolicy {
  version: 1;
  checkName: "Factory PR Review";
  rubric: { version: 2; maxFindings: 50; minimumConfidence: 0.9 };
  sizeLimit: ReviewSizeLimit;
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
    validateProviderConfiguration(repository.id, "provider", repository.provider);
    if (repository.canaryProvider !== undefined) {
      validateProviderConfiguration(
        repository.id,
        "canary provider",
        repository.canaryProvider,
      );
    }
    validateCanaryStart(repository);
    validateCanaryProvider(repository);
    validateCredentialSecret(
      repository.id,
      "credential",
      repository.provider,
      repository.credential,
    );
    validateCredentialDates(repository.id, "credential", repository.credential, now);
    validateUsageLimitFallback(repository, now);
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
    !sameProvider(canaryProvider, provider)
  ) {
    throw new Error(
      `Repository "${repository.id}" provider ${describeProvider(provider)} differs from its canary ${describeProvider(canaryProvider)}; start a new canary`,
    );
  }
}

function describeProvider(provider: ReviewProvider): string {
  return [provider.id, provider.model, provider.effort].filter(Boolean).join("/");
}

function validateUsageLimitFallback(
  repository: RepositoryReviewPolicy,
  now: Date,
): void {
  const fallback = repository.usageLimitFallback;
  if (fallback === undefined) {
    return;
  }
  if (repository.provider.id !== "claude") {
    throw new Error(
      `Repository "${repository.id}" usage-limit fallback requires Claude as the primary provider`,
    );
  }
  if (fallback.provider.id !== "codex") {
    throw new Error(
      `Repository "${repository.id}" usage-limit fallback provider must be Codex`,
    );
  }
  validateProviderConfiguration(
    repository.id,
    "usage-limit fallback provider",
    fallback.provider,
  );
  validateProviderConfiguration(
    repository.id,
    "usage-limit fallback canary provider",
    fallback.canaryProvider,
  );
  if (!sameProvider(fallback.provider, fallback.canaryProvider)) {
    throw new Error(
      `Repository "${repository.id}" usage-limit fallback ${describeProvider(fallback.provider)} differs from its canary ${describeProvider(fallback.canaryProvider)}; start a new canary`,
    );
  }
  validateCredentialSecret(
    repository.id,
    "usage-limit fallback credential",
    fallback.provider,
    fallback.credential,
  );
  validateCredentialDates(
    repository.id,
    "usage-limit fallback credential",
    fallback.credential,
    now,
  );
}

function sameProvider(left: ReviewProvider, right: ReviewProvider): boolean {
  return (
    left.id === right.id &&
    left.model === right.model &&
    left.effort === right.effort
  );
}

function validateProviderConfiguration(
  repositoryId: string,
  label: string,
  provider: ReviewProvider,
): void {
  if (provider.id === "codex" && provider.effort === undefined) {
    throw new Error(
      `Repository "${repositoryId}" ${label} ${describeProvider(provider)} must pin reasoning effort`,
    );
  }
  if (provider.id === "claude" && provider.effort !== undefined) {
    throw new Error(
      `Repository "${repositoryId}" ${label} must not set Codex reasoning effort for Claude`,
    );
  }
}

function validateCredentialSecret(
  repositoryId: string,
  label: string,
  provider: ReviewProvider,
  credential: ReviewCredential | undefined,
): void {
  const secret = credential?.secret;
  const expected = providerCredentialSecrets[provider.id];
  if (secret !== undefined && secret !== expected) {
    throw new Error(
      `Repository "${repositoryId}" ${label} secret ${secret} must be ${expected} for provider ${provider.id}`,
    );
  }
}

function validateCredentialDates(
  repositoryId: string,
  label: string,
  credential: ReviewCredential | undefined,
  now: Date,
): void {
  if (credential?.expiresOn === undefined || credential.rotateBy === undefined) {
    return;
  }
  const expiresAt = parseDate(credential.expiresOn, repositoryId, label, "expiresOn");
  const rotateAt = parseDate(credential.rotateBy, repositoryId, label, "rotateBy");
  if (rotateAt > expiresAt) {
    throw new Error(
      `Repository "${repositoryId}" ${label} rotateBy must not be after expiresOn`,
    );
  }
  if (now.getTime() >= expiresAt) {
    throw new Error(
      `Repository "${repositoryId}" ${label} expired on ${credential.expiresOn}`,
    );
  }
}

function parseDate(
  value: string,
  repositoryId: string,
  label: string,
  field: string,
): number {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time)) {
    throw new Error(`Repository "${repositoryId}" ${label} ${field} is not a valid date`);
  }
  return time;
}
