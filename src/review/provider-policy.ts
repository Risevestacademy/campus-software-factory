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

export interface RepositoryReviewPolicy {
  id: string;
  mode: ReviewMode;
  ciWorkflowName: string;
  targetBranches: ("dev" | "main")[];
  provider: { id: ProviderId; model: string };
  canaryStartsAt?: string;
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

const credentialSecretPatterns: Readonly<Record<ProviderId, RegExp>> = {
  claude: /^CLAUDE_CODE_OAUTH_TOKEN(_[A-Z0-9]+)*$/,
  codex: /^OPENAI_API_KEY(_[A-Z0-9]+)*$/,
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

function validateCredentialSecret(repository: RepositoryReviewPolicy): void {
  const secret = repository.credential?.secret;
  if (
    secret !== undefined &&
    !credentialSecretPatterns[repository.provider.id].test(secret)
  ) {
    throw new Error(
      `Repository "${repository.id}" credential secret ${secret} does not match provider ${repository.provider.id}`,
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
