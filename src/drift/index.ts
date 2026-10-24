export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RulesetSnapshot {
  repositories: RepositoryRulesetSnapshot[];
}

export interface RepositoryRulesetSnapshot {
  repository: string;
  rulesets: RulesetDefinition[];
}

export interface RulesetBypassActor {
  actorId: number | null;
  actorType: string;
  bypassMode: string;
}

export interface RulesetRule {
  type: string;
  parameters?: JsonObject;
}

export interface RulesetDefinition {
  name: string;
  target: string;
  source: string;
  sourceType: string;
  enforcement: "active" | "disabled" | "evaluate";
  conditions: JsonObject;
  bypassActors: RulesetBypassActor[];
  rules: RulesetRule[];
}

export interface DriftFinding {
  kind: "missing" | "unexpected" | "changed";
  path: string;
  expected?: unknown;
  actual?: unknown;
}

export function compareRulesetSnapshots(
  expected: RulesetSnapshot,
  actual: RulesetSnapshot,
): readonly DriftFinding[] {
  const findings: DriftFinding[] = [];
  const expectedRepositories = indexByUniqueName(
    expected.repositories,
    (repository) => repository.repository,
    "expected repository",
  );
  const actualRepositories = indexByUniqueName(
    actual.repositories,
    (repository) => repository.repository,
    "actual repository",
  );

  for (const repositoryName of sortedKeys(expectedRepositories)) {
    const expectedRepository = expectedRepositories.get(repositoryName);
    const actualRepository = actualRepositories.get(repositoryName);
    if (expectedRepository === undefined) {
      continue;
    }
    if (actualRepository === undefined) {
      findings.push({
        kind: "missing",
        path: repositoryName,
        expected: expectedRepository,
      });
      continue;
    }
    compareRepositoryRulesets(
      repositoryName,
      expectedRepository,
      actualRepository,
      findings,
    );
  }

  for (const repositoryName of sortedKeys(actualRepositories)) {
    if (!expectedRepositories.has(repositoryName)) {
      findings.push({
        kind: "unexpected",
        path: repositoryName,
        actual: actualRepositories.get(repositoryName),
      });
    }
  }

  return findings;
}

export function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value
      .map(canonicalizeJson)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function compareRepositoryRulesets(
  repositoryName: string,
  expected: RepositoryRulesetSnapshot,
  actual: RepositoryRulesetSnapshot,
  findings: DriftFinding[],
): void {
  const expectedRulesets = indexByUniqueName(
    expected.rulesets,
    (ruleset) => ruleset.name,
    `expected ruleset in ${repositoryName}`,
  );
  const actualRulesets = indexByUniqueName(
    actual.rulesets,
    (ruleset) => ruleset.name,
    `actual ruleset in ${repositoryName}`,
  );

  for (const rulesetName of sortedKeys(expectedRulesets)) {
    const path = `${repositoryName}/rulesets/${rulesetName}`;
    const expectedRuleset = expectedRulesets.get(rulesetName);
    const actualRuleset = actualRulesets.get(rulesetName);
    if (expectedRuleset === undefined) {
      continue;
    }
    if (actualRuleset === undefined) {
      findings.push({ kind: "missing", path, expected: expectedRuleset });
      continue;
    }

    compareJson(
      path,
      canonicalizeJson(toComparableRuleset(expectedRuleset)),
      canonicalizeJson(toComparableRuleset(actualRuleset)),
      findings,
    );
  }

  for (const rulesetName of sortedKeys(actualRulesets)) {
    if (!expectedRulesets.has(rulesetName)) {
      findings.push({
        kind: "unexpected",
        path: `${repositoryName}/rulesets/${rulesetName}`,
        actual: actualRulesets.get(rulesetName),
      });
    }
  }
}

function toComparableRuleset(ruleset: RulesetDefinition): JsonObject {
  return {
    target: ruleset.target,
    source: ruleset.source,
    sourceType: ruleset.sourceType,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    bypassActors: ruleset.bypassActors.map((actor) => ({
      actorId: actor.actorId,
      actorType: actor.actorType,
      bypassMode: actor.bypassMode,
    })),
    rules: ruleset.rules.map((rule) => ({
      type: rule.type,
      ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
    })),
  };
}

function compareJson(
  path: string,
  expected: JsonValue,
  actual: JsonValue,
  findings: DriftFinding[],
): void {
  if (isJsonObject(expected) && isJsonObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const expectedValue = expected[key];
      const actualValue = actual[key];
      const childPath = `${path}/${key}`;
      if (expectedValue === undefined) {
        findings.push({ kind: "unexpected", path: childPath, actual: actualValue });
      } else if (actualValue === undefined) {
        findings.push({ kind: "missing", path: childPath, expected: expectedValue });
      } else {
        compareJson(childPath, expectedValue, actualValue, findings);
      }
    }
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const expectedValue = expected[index];
      const actualValue = actual[index];
      const childPath = `${path}/${index}`;
      if (expectedValue === undefined) {
        findings.push({ kind: "unexpected", path: childPath, actual: actualValue });
      } else if (actualValue === undefined) {
        findings.push({ kind: "missing", path: childPath, expected: expectedValue });
      } else {
        compareJson(childPath, expectedValue, actualValue, findings);
      }
    }
    return;
  }

  if (!Object.is(expected, actual)) {
    findings.push({ kind: "changed", path, expected, actual });
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexByUniqueName<T>(
  items: readonly T[],
  getName: (item: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    const name = getName(item);
    if (index.has(name)) {
      throw new Error(`Duplicate ${label} "${name}"`);
    }
    index.set(name, item);
  }
  return index;
}

function sortedKeys<T>(index: ReadonlyMap<string, T>): readonly string[] {
  return [...index.keys()].sort();
}
