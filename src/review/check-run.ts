import type { ProviderId, ReviewFinding } from "./contracts.ts";
import type { ReviewMode } from "./provider-policy.ts";

export const checkRunName = "Factory PR Review";

export type ReviewOutcome =
  | { kind: "clean" }
  | { kind: "findings"; findings: ReviewFinding[] }
  | { kind: "missing-purpose" }
  | { kind: "technical"; reason: string }
  | { kind: "fork" };

export type CheckOutcomeTag = ReviewOutcome["kind"] | "pending";

export interface CheckRunContext {
  ciRunId: number;
  mode: ReviewMode;
  provider: ProviderId;
  model: string;
  purpose: string | null;
}

export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "failure";
  title: string;
  message: string;
}

export interface CheckRunReport {
  name: typeof checkRunName;
  conclusion: "success" | "failure" | "neutral";
  externalId: string;
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

const externalIdPattern =
  /^factory-review:v1:(pending|clean|findings|missing-purpose|technical|fork):(\d+)$/;

export function buildCheckRunReport(
  outcome: ReviewOutcome,
  context: CheckRunContext,
): CheckRunReport {
  const report = (
    conclusion: CheckRunReport["conclusion"],
    title: string,
    body: string,
    annotations: CheckAnnotation[] = [],
  ): CheckRunReport => ({
    name: checkRunName,
    conclusion,
    externalId: externalId(outcome.kind, context.ciRunId),
    title,
    summary: [body, footer(context)].join("\n\n"),
    annotations,
  });

  switch (outcome.kind) {
    case "clean":
      return report(
        "success",
        "No blocking findings",
        withPurpose(context, "The review found no change that must be made before merge."),
      );
    case "findings":
      return report(
        "failure",
        `${outcome.findings.length} blocking finding${outcome.findings.length === 1 ? "" : "s"}`,
        withPurpose(context, formatFindingSections(outcome.findings)),
        outcome.findings.map(toAnnotation),
      );
    case "missing-purpose":
      return report(
        "failure",
        "PR purpose missing",
        "Add a non-empty `## Change and measurable outcome` section to the PR description, then re-run this workflow.",
      );
    case "technical":
      return report(
        "failure",
        "Review could not complete",
        `The reviewer did not produce a valid result: ${outcome.reason}\n\nRe-run this workflow. A same-SHA rerun is allowed after technical errors.`,
      );
    case "fork":
      return report(
        "neutral",
        "Human review only (fork)",
        "Fork pull requests are not sent to the AI reviewer. CODEOWNER review remains required.",
      );
    default:
      return assertNever(outcome);
  }
}

export function formatFindingSections(findings: readonly ReviewFinding[]): string {
  return (["standards", "spec"] as const)
    .map((axis) => {
      const matchingFindings = findings.filter((finding) => finding.axis === axis);
      const content =
        matchingFindings.length === 0
          ? "No requested changes."
          : matchingFindings.map(formatFinding).join("\n\n");
      return `## ${axis === "standards" ? "Standards" : "Spec"}\n\n${content}`;
    })
    .join("\n\n");
}

export function externalId(tag: CheckOutcomeTag, ciRunId: number): string {
  return `factory-review:v1:${tag}:${ciRunId}`;
}

export function parseExternalId(
  value: string | null,
): { outcome: CheckOutcomeTag; ciRunId: number } | null {
  const match = value?.match(externalIdPattern);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { outcome: match[1] as CheckOutcomeTag, ciRunId: Number(match[2]) };
}

export function isDecisiveOutcome(tag: CheckOutcomeTag): boolean {
  return tag === "clean" || tag === "findings";
}

function withPurpose(context: CheckRunContext, body: string): string {
  return context.purpose === null
    ? body
    : `**PR purpose:** ${context.purpose}\n\n${body}`;
}

function footer(context: CheckRunContext): string {
  const modeLine =
    context.mode === "enforced"
      ? "Enforced: required before merge into dev and main."
      : "Advisory canary: this check does not block merge yet.";
  return [
    "---",
    modeLine,
    `Reviewer: ${context.provider} / ${context.model}`,
    `CI run: ${context.ciRunId}`,
  ].join("\n");
}

function formatFinding(finding: ReviewFinding): string {
  return [
    `### ${finding.severity}: ${finding.title}`,
    `- Location: \`${finding.path}:${finding.line}\``,
    `- Evidence: ${finding.evidence}`,
    `- Failure scenario: ${finding.failureScenario}`,
    `- Required change: ${finding.requestedChange}`,
    `- Basis: ${finding.source}`,
  ].join("\n");
}

function toAnnotation(finding: ReviewFinding): CheckAnnotation {
  return {
    path: finding.path,
    startLine: finding.line,
    endLine: finding.line,
    annotationLevel: "failure",
    title: `${finding.severity}: ${finding.title}`,
    message: [
      finding.evidence,
      `Failure scenario: ${finding.failureScenario}`,
      `Required change: ${finding.requestedChange}`,
    ].join("\n\n"),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled review outcome ${JSON.stringify(value)}`);
}
