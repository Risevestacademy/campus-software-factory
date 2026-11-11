import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { parsePolicyDocuments } from "../policy/index.js";
import type {
  JsonObject,
  JsonValue,
  RepositoryRulesetSnapshot,
  RulesetDefinition,
  RulesetRule,
  RulesetSnapshot,
} from "./index.js";

export async function collectRepository(
  repository: string,
  authorizationToken: string,
): Promise<RepositoryRulesetSnapshot> {
  const summaries = requireArray(
    await requestJson(`/repos/${repository}/rulesets?per_page=100`, authorizationToken),
    "GitHub ruleset summaries",
  );
  const factoryRulesets = summaries.filter((value) => {
    const ruleset = requireObject(value, "GitHub ruleset summary");
    return requireString(ruleset.name, "ruleset name").startsWith("factory-");
  });
  const rulesets = await Promise.all(
    factoryRulesets.map(async (value) => {
      const summary = requireObject(value, "GitHub ruleset summary");
      const id = requireNumber(summary.id, "ruleset id");
      return normalizeRuleset(
        await requestJson(
          `/repos/${repository}/rulesets/${id}`,
          authorizationToken,
        ),
      );
    }),
  );

  return {
    repository,
    rulesets: rulesets.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

const codeownersLocations = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export async function collectCodeowners(
  repository: string,
  authorizationToken: string,
): Promise<string | null> {
  for (const location of codeownersLocations) {
    const file = await requestOptionalJson(
      `/repos/${repository}/contents/${location}`,
      authorizationToken,
    );
    if (file !== null) {
      const content = requireString(
        requireObject(file, "CODEOWNERS file").content,
        "CODEOWNERS content",
      );
      return Buffer.from(content, "base64").toString("utf8");
    }
  }
  return null;
}

export async function resolveTeamId(
  organizationTeam: string,
  authorizationToken: string,
): Promise<number | null> {
  const [organization, slug] = organizationTeam.split("/");
  if (organization === undefined || slug === undefined || slug.length === 0) {
    throw new Error(`Owner team "${organizationTeam}" must be "organization/team-slug"`);
  }
  const team = await requestOptionalJson(
    `/orgs/${organization}/teams/${slug}`,
    authorizationToken,
  );
  return team === null ? null : requireNumber(requireObject(team, "team").id, "team id");
}

export function normalizeRuleset(value: unknown): RulesetDefinition {
  const ruleset = requireObject(value, "GitHub ruleset");
  const enforcement = requireString(ruleset.enforcement, "ruleset enforcement");
  if (!isEnforcement(enforcement)) {
    throw new Error(`Ruleset has unsupported enforcement "${enforcement}"`);
  }

  return {
    name: requireString(ruleset.name, "ruleset name"),
    target: requireString(ruleset.target, "ruleset target"),
    source: requireString(ruleset.source, "ruleset source"),
    sourceType: requireString(ruleset.source_type, "ruleset source type"),
    enforcement,
    conditions: toJsonObject(ruleset.conditions, "ruleset conditions"),
    bypassActors: requireBypassActors(ruleset).map((actorValue) => {
      const actor = requireObject(actorValue, "ruleset bypass actor");
      return {
        actorId:
          actor.actor_id === null || actor.actor_id === undefined
            ? null
            : requireNumber(actor.actor_id, "bypass actor id"),
        actorType: requireString(actor.actor_type, "bypass actor type"),
        bypassMode: requireString(actor.bypass_mode, "bypass mode"),
      };
    }),
    rules: requireArray(ruleset.rules ?? [], "ruleset rules").map(normalizeRule),
  };
}

// GitHub withholds bypass_actors from tokens without write access to the ruleset;
// treating that as [] would report or hide bypass drift.
function requireBypassActors(ruleset: Record<string, unknown>): unknown[] {
  if (ruleset.bypass_actors === undefined) {
    throw new Error(
      `Ruleset "${String(ruleset.name)}" has no bypass_actors; the audit token needs Administration: write`,
    );
  }
  return requireArray(ruleset.bypass_actors, "ruleset bypass actors");
}

function normalizeRule(value: unknown): RulesetRule {
  const rule = requireObject(value, "ruleset rule");
  return {
    type: requireString(rule.type, "rule type"),
    ...(rule.parameters === undefined
      ? {}
      : { parameters: toJsonObject(rule.parameters, "rule parameters") }),
  };
}

async function main(): Promise<void> {
  const token = process.env.FACTORY_AUDIT_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("FACTORY_AUDIT_TOKEN is required");
  }
  const registryPath = resolve(process.argv[2] ?? "policies/repo-registry.yaml");
  const sensitivePathsPath = resolve(
    process.argv[3] ?? "policies/sensitive-paths.yaml",
  );
  const [registrySource, sensitivePathsSource] = await Promise.all([
    readFile(registryPath, "utf8"),
    readFile(sensitivePathsPath, "utf8"),
  ]);
  const policy = parsePolicyDocuments(registrySource, sensitivePathsSource);
  const repositories = await Promise.all(
    policy.repositories.map((repository) =>
      collectRepository(repository.github, token),
    ),
  );
  const snapshot: RulesetSnapshot = { repositories };
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

async function requestJson(path: string, authorizationToken: string): Promise<unknown> {
  const value = await requestOptionalJson(path, authorizationToken);
  if (value === null) {
    throw new Error(`GitHub request ${path} failed with 404 Not Found`);
  }
  return value;
}

async function requestOptionalJson(
  path: string,
  authorizationToken: string,
): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authorizationToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub request ${path} failed with ${response.status} ${response.statusText}`,
    );
  }
  return response.json() as Promise<unknown>;
}

function toJsonObject(value: unknown, label: string): JsonObject {
  const object = requireObject(value, label);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, toJsonValue(entry, `${label}.${key}`)]),
  );
}

function toJsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => toJsonValue(entry, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    return toJsonObject(value, label);
  }
  throw new Error(`${label} must contain only JSON values`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function isEnforcement(value: string): value is RulesetDefinition["enforcement"] {
  return value === "active" || value === "disabled" || value === "evaluate";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
