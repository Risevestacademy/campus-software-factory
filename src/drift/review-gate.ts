import { checkRunName } from "../review/check-run.js";
import type { ReviewMode } from "../review/provider-policy.js";
import type {
  DriftFinding,
  JsonValue,
  RulesetBypassActor,
  RulesetDefinition,
} from "./index.js";

export interface ReviewGateInput {
  repository: string;
  ownerTeam: string;
  ownerTeamId: number | null;
  codeowners: string | null;
  mode: Exclude<ReviewMode, "disabled">;
  rulesets: readonly RulesetDefinition[];
}

const qualityRulesetName = "factory-quality";
const protectedRefs = ["refs/heads/dev", "refs/heads/main"];
const teamOwner = /^@[^/\s]+\/[^/\s]+$/;

export function auditReviewGate(input: ReviewGateInput): DriftFinding[] {
  const findings = [...auditCodeowners(input)];
  if (input.ownerTeamId === null) {
    findings.push({
      kind: "missing",
      path: `${input.repository}/teams/${input.ownerTeam}`,
      expected: input.ownerTeam,
    });
  }

  const quality = input.rulesets.find((ruleset) => ruleset.name === qualityRulesetName);
  if (quality === undefined) {
    findings.push({
      kind: "missing",
      path: `${input.repository}/${qualityRulesetName}`,
      expected: qualityRulesetName,
    });
    return findings;
  }
  const rulesetPath = `${input.repository}/${qualityRulesetName}`;

  if (input.ownerTeamId !== null) {
    const expectedBypass: RulesetBypassActor[] = [
      { actorId: input.ownerTeamId, actorType: "Team", bypassMode: "pull_request" },
    ];
    if (!sameBypass(quality.bypassActors, expectedBypass)) {
      findings.push({
        kind: "changed",
        path: `${rulesetPath}/bypassActors`,
        expected: expectedBypass,
        actual: quality.bypassActors,
      });
    }
  }

  const includedRefs = stringArray(objectField(quality.conditions.ref_name, "include"));
  if (!protectedRefs.every((ref) => includedRefs.includes(ref))) {
    findings.push({
      kind: "changed",
      path: `${rulesetPath}/conditions`,
      expected: protectedRefs,
      actual: includedRefs,
    });
  }

  const requiresReview = requiredContexts(quality).includes(checkRunName);
  if (requiresReview !== (input.mode === "enforced")) {
    findings.push({
      kind: "changed",
      path: `${rulesetPath}/required_status_checks`,
      expected:
        input.mode === "enforced"
          ? `requires ${checkRunName}`
          : `does not yet require ${checkRunName}`,
      actual: requiredContexts(quality),
    });
  }
  return findings;
}

export function auditCodeowners(
  input: Pick<ReviewGateInput, "repository" | "ownerTeam" | "codeowners">,
): DriftFinding[] {
  if (input.codeowners === null) {
    return [
      {
        kind: "missing",
        path: `${input.repository}/CODEOWNERS`,
        expected: `@${input.ownerTeam}`,
      },
    ];
  }
  const expectedOwner = `@${input.ownerTeam}`;
  return input.codeowners.split(/\r?\n/).flatMap((rawLine, index) => {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line.length === 0) {
      return [];
    }
    const owners = line.split(/\s+/).slice(1);
    const includesOwnerTeam = owners.some(
      (owner) => owner.toLowerCase() === expectedOwner.toLowerCase(),
    );
    // Rulesets bypass only teams, so a user owner could approve but never match the bypass set.
    const teamsOnly = owners.every((owner) => teamOwner.test(owner));
    return includesOwnerTeam && teamsOnly
      ? []
      : [
          {
            kind: "changed" as const,
            path: `${input.repository}/CODEOWNERS:${index + 1}`,
            expected: `includes ${expectedOwner}; team owners only`,
            actual: owners,
          },
        ];
  });
}

function sameBypass(
  actual: readonly RulesetBypassActor[],
  expected: readonly RulesetBypassActor[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((wanted) =>
      actual.some(
        (actor) =>
          actor.actorId === wanted.actorId &&
          actor.actorType === wanted.actorType &&
          actor.bypassMode === wanted.bypassMode,
      ),
    )
  );
}

function requiredContexts(ruleset: RulesetDefinition): string[] {
  const rule = ruleset.rules.find((entry) => entry.type === "required_status_checks");
  const checks = rule?.parameters?.required_status_checks;
  return Array.isArray(checks)
    ? checks.flatMap((check) => {
        const context = objectField(check, "context");
        return typeof context === "string" ? [context] : [];
      })
    : [];
}

function objectField(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
