import { matchesGlob } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  validateRepositoryRegistry,
  validateSensitivePaths,
} from "./schema.js";

export type RiskTier = "R0" | "R1" | "R2" | "R3" | "R4";

export interface PathRule {
  pattern: string;
  tier: RiskTier;
}

export interface PathPolicy {
  mechanicalAllowlist: readonly PathRule[];
  sensitivePaths: readonly PathRule[];
}

export interface RepositoryPolicy {
  id: string;
  github: string;
  ownerTeam: string;
  workflow: "web" | "server" | "mobile";
}

export interface FactoryPolicyBundle {
  repositories: readonly RepositoryPolicy[];
  paths: PathPolicy;
}

export function parsePolicyDocuments(
  repositoryRegistryYaml: string,
  sensitivePathsYaml: string,
): FactoryPolicyBundle {
  const repositoryDocument = parseYamlDocument(
    repositoryRegistryYaml,
    "repository registry",
  );
  const pathDocument = parseYamlDocument(sensitivePathsYaml, "sensitive paths");
  requireVersion(repositoryDocument, "repository registry");
  requireVersion(pathDocument, "sensitive paths");

  const rawRepositories = requireArray(
    repositoryDocument.repositories,
    "Repository registry repositories",
  );
  const repositories = rawRepositories.map((entry, index) => {
    const repository = requireObject(entry, `Repository at index ${index}`);
    const id = requireString(repository.id, `Repository at index ${index} id`);
    const workflow = requireString(
      repository.workflow,
      `Repository "${id}" workflow`,
    );
    if (!isWorkflow(workflow)) {
      throw new Error(
        `Repository "${id}" has unsupported workflow "${workflow}"`,
      );
    }

    return {
      id,
      github: requireString(
        repository.github,
        `Repository "${id}" GitHub repository`,
      ),
      ownerTeam: requireString(
        repository.ownerTeam,
        `Repository "${id}" owner team`,
      ),
      workflow,
    } satisfies RepositoryPolicy;
  });
  const bundle: FactoryPolicyBundle = {
    repositories,
    paths: {
      mechanicalAllowlist: parsePathRules(
        pathDocument.mechanicalAllowlist,
        "Mechanical allowlist",
      ),
      sensitivePaths: parsePathRules(
        pathDocument.sensitivePaths,
        "Sensitive paths",
      ),
    },
  };

  validateRepositoryRegistry(repositoryDocument);
  validateSensitivePaths(pathDocument);
  validatePolicyBundle(bundle);
  return bundle;
}

export function classifyChangedPaths(
  changedPaths: readonly string[],
  policy: PathPolicy,
): RiskTier {
  if (changedPaths.length === 0) {
    return "R2";
  }

  const sensitiveTiers = changedPaths.flatMap((changedPath) =>
    policy.sensitivePaths
      .filter((rule) => pathMatches(changedPath, rule.pattern))
      .map((rule) => rule.tier),
  );

  if (sensitiveTiers.length > 0) {
    return highestTier(sensitiveTiers);
  }

  const allowlistedTiers = changedPaths.map((changedPath) => {
    const matchingRules = policy.mechanicalAllowlist.filter((rule) =>
      pathMatches(changedPath, rule.pattern),
    );
    return matchingRules.length === 0
      ? undefined
      : highestTier(matchingRules.map((rule) => rule.tier));
  });

  if (allowlistedTiers.some((tier) => tier === undefined)) {
    return "R2";
  }

  return highestTier(allowlistedTiers as RiskTier[]);
}

export function validatePolicyBundle(bundle: FactoryPolicyBundle): void {
  const repositoryIds = new Set<string>();
  const githubRepositories = new Set<string>();

  for (const repository of bundle.repositories) {
    requireValue(repository.id, "Repository id");
    requireValue(repository.github, `GitHub repository for "${repository.id}"`);
    requireValue(repository.ownerTeam, `Owner team for "${repository.id}"`);

    if (repositoryIds.has(repository.id)) {
      throw new Error(`Duplicate repository id "${repository.id}"`);
    }
    if (githubRepositories.has(repository.github)) {
      throw new Error(`Duplicate GitHub repository "${repository.github}"`);
    }

    repositoryIds.add(repository.id);
    githubRepositories.add(repository.github);
  }

  validatePathRules(
    bundle.paths.mechanicalAllowlist,
    new Set<RiskTier>(["R0", "R1"]),
    "mechanical allowlist",
  );
  validatePathRules(
    bundle.paths.sensitivePaths,
    new Set<RiskTier>(["R3", "R4"]),
    "sensitive paths",
  );
}

const TIER_WEIGHT: Readonly<Record<RiskTier, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

function highestTier(tiers: readonly RiskTier[]): RiskTier {
  if (tiers.length === 0) {
    return "R2";
  }

  return tiers.reduce((highest, candidate) =>
    TIER_WEIGHT[candidate] > TIER_WEIGHT[highest] ? candidate : highest,
  );
}

function pathMatches(changedPath: string, pattern: string): boolean {
  const normalizedPath = changedPath.replaceAll("\\", "/");
  return matchesGlob(normalizedPath, pattern);
}

function validatePathRules(
  rules: readonly PathRule[],
  allowedTiers: ReadonlySet<RiskTier>,
  label: string,
): void {
  const patterns = new Set<string>();

  for (const rule of rules) {
    requireValue(rule.pattern, `Pattern in ${label}`);
    if (!allowedTiers.has(rule.tier)) {
      throw new Error(`Tier ${rule.tier} is not valid in ${label}`);
    }
    if (patterns.has(rule.pattern)) {
      throw new Error(`Duplicate pattern "${rule.pattern}" in ${label}`);
    }
    patterns.add(rule.pattern);
  }
}

function requireValue(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function parseYamlDocument(source: string, label: string): Record<string, unknown> {
  try {
    return requireObject(parseYaml(source) as unknown, label);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Invalid ${label}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function parsePathRules(value: unknown, label: string): readonly PathRule[] {
  return requireArray(value, label).map((entry, index) => {
    const rule = requireObject(entry, `${label} rule at index ${index}`);
    const tier = requireString(rule.tier, `${label} rule tier`);
    if (!isRiskTier(tier)) {
      throw new Error(`${label} rule has unsupported tier "${tier}"`);
    }
    return {
      pattern: requireString(rule.pattern, `${label} rule pattern`),
      tier,
    };
  });
}

function requireVersion(document: Record<string, unknown>, label: string): void {
  if (document.version !== 1) {
    throw new Error(`${label} version must be 1`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isWorkflow(value: string): value is RepositoryPolicy["workflow"] {
  return value === "web" || value === "server" || value === "mobile";
}

function isRiskTier(value: string): value is RiskTier {
  return value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4";
}
