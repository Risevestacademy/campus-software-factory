import {
  findingsCeiling,
  severityRank,
  type ProviderId,
  type ReviewFinding,
} from "./contracts.ts";
import type { ReviewMode, ReviewReasoningEffort } from "./provider-policy.ts";

export const checkRunName = "Factory PR Review";

export type ReviewOutcome =
  | { kind: "clean" }
  | { kind: "findings"; findings: ReviewFinding[] }
  | { kind: "missing-purpose"; reason: "absent" | "too-vague" }
  | { kind: "technical"; reason: string }
  | {
      kind: "too-large";
      changedLines: number;
      changedFiles: number;
      maxChangedLines: number;
      maxChangedFiles: number;
    }
  | { kind: "fork" };

export type CheckOutcomeTag = ReviewOutcome["kind"] | "pending";

export interface CheckRunContext {
  ciRunId: number;
  mode: ReviewMode;
  provider: ProviderId;
  model: string;
  effort?: ReviewReasoningEffort;
  purpose: string | null;
  fallback?: {
    primaryProvider: ProviderId;
    primaryModel: string;
    refillAt?: string;
  };
}

export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "failure";
  title: string;
  message: string;
}

interface ReportDetails {
  purpose?: string | null;
  annotations?: CheckAnnotation[];
}

export interface CheckRunReport {
  name: typeof checkRunName;
  conclusion: "success" | "failure" | "neutral";
  externalId: string;
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

// GitHub rejects a check-run summary longer than this.
export const checkRunSummaryLimit = 65_535;
const paragraphBreak = "\n\n";
const purposeLabel = "**PR purpose:** ";
const purposeTruncationMarker = " … (truncated)";

const externalIdPattern =
  /^factory-review:v1:(pending|clean|findings|missing-purpose|technical|too-large|fork):(\d+)$/;

export function buildCheckRunReport(
  outcome: ReviewOutcome,
  context: CheckRunContext,
): CheckRunReport {
  const report = (
    conclusion: CheckRunReport["conclusion"],
    title: string,
    body: string,
    { purpose = null, annotations = [] }: ReportDetails = {},
  ): CheckRunReport => ({
    name: checkRunName,
    conclusion,
    externalId: externalId(outcome.kind, context.ciRunId),
    title,
    summary: composeSummary(purpose, body, footer(context)),
    annotations,
  });
  const { purpose } = context;

  switch (outcome.kind) {
    case "clean":
      return report(
        "success",
        "No blocking findings",
        "The review found no change that must be made before merge.",
        { purpose },
      );
    case "findings": {
      const findings = bySeverity(outcome.findings);
      return report(
        "failure",
        `${findings.length} blocking finding${findings.length === 1 ? "" : "s"}`,
        formatFindingSections(findings) + ceilingNotice(findings),
        { purpose, annotations: findings.map(toAnnotation) },
      );
    }
    case "missing-purpose":
      return outcome.reason === "absent"
        ? report(
            "failure",
            "PR purpose missing",
            "Add a non-empty `## Change and measurable outcome` section to the PR description, then re-run this workflow.",
          )
        : report(
            "failure",
            "PR purpose too vague",
            "The reviewer judged `## Change and measurable outcome` too vague to review against. Name the behavior or metric that changes, then re-run this workflow.",
            { purpose },
          );
    case "technical":
      return report(
        "failure",
        "Review could not complete",
        `Review failed: ${outcome.reason}\n\nRe-run this workflow. A same-SHA rerun is allowed after technical errors.`,
      );
    case "too-large":
      return report(
        "neutral",
        "Human review only (PR too large)",
        `This pull request changes ${outcome.changedLines} lines across ${outcome.changedFiles} files. The AI review limit is ${outcome.maxChangedLines} changed lines and ${outcome.maxChangedFiles} changed files. CODEOWNER review remains required.`,
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
          : matchingFindings.map(formatFindingLine).join("\n");
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

function footer(context: CheckRunContext): string {
  const modeLine =
    context.mode === "enforced"
      ? "Enforced: required before merge into dev and main."
      : "Advisory canary: this check does not block merge yet.";
  const lines = ["---", modeLine];
  if (context.fallback !== undefined) {
    lines.push(
      `Fallback: ${context.fallback.primaryProvider} / ${context.fallback.primaryModel} reached its usage limit.`,
      context.fallback.refillAt === undefined
        ? "Claude refill: not reported. Future reviews will try Claude first."
        : `Claude refill: ${context.fallback.refillAt}. Future reviews will try Claude first.`,
    );
  }
  lines.push(
    `Reviewer: ${[context.provider, context.model, context.effort].filter(Boolean).join(" / ")}`,
    `CI run: ${context.ciRunId}`,
  );
  return lines.join("\n");
}

function bySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (left, right) => severityRank[left.severity] - severityRank[right.severity],
  );
}

function ceilingNotice(findings: readonly ReviewFinding[]): string {
  return findings.length >= findingsCeiling
    ? `\n\n**Ceiling reached:** GitHub accepts ${findingsCeiling} annotations per update, so more findings may exist. Split this pull request.`
    : "";
}

// Detail lives in the annotations; one line per finding keeps the summary under GitHub's limit.
function formatFindingLine(finding: ReviewFinding): string {
  return `- **${finding.severity}** ${finding.title} (\`${finding.path}:${finding.line}\`)`;
}

// The purpose is author-written and unbounded; findings and the footer are
// bounded by the output schema, so only the purpose is ever shortened.
function composeSummary(purpose: string | null, body: string, footerText: string): string {
  const fixed = `${body}${paragraphBreak}${footerText}`;
  if (purpose === null) {
    return fixed;
  }
  const room =
    checkRunSummaryLimit - fixed.length - purposeLabel.length - paragraphBreak.length;
  const shown =
    purpose.length <= room
      ? purpose
      : `${purpose.slice(0, room - purposeTruncationMarker.length)}${purposeTruncationMarker}`;
  return `${purposeLabel}${shown}${paragraphBreak}${fixed}`;
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
      `Basis: ${finding.source}`,
    ].join("\n\n"),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled review outcome ${JSON.stringify(value)}`);
}
