import { appendFileSync } from "node:fs";

import { formatNotice, formatOutput } from "./github-output.ts";
import { GitHubRestAdapter } from "./github-rest-adapter.ts";
import { loadRepositoryReview } from "./policy-loader.ts";
import {
  createFactoryReviewExecution,
  nextReviewAttempt,
  providerAdapter,
  readProviderOutput,
  renderReviewPrompt,
  reviewAttributionFor,
  reviewMaxTurns,
  reviewOutputSchema,
  reviewOutputSchemaPath,
  type ExecutionPolicy,
  type ProviderFailureKind,
  type ProviderId,
  type PublishResult,
  type ReviewAttempt,
  type ReviewAttribution,
  type ReviewProvider,
  type ReviewReasoningEffort,
  type ReviewTicket,
} from "./index.ts";

const phases = ["preflight", "validate", "route", "publish", "fail"] as const;
type Phase = (typeof phases)[number];

const phase = process.argv[2];
if (!isPhase(phase)) {
  throw new Error(`Review action phase must be one of ${phases.join(", ")}`);
}

const repository = required("REPOSITORY");
const { review, policy: reviewPolicy } = await loadRepositoryReview(
  (entry) => entry.github === repository,
  new Date(),
);
const policy: ExecutionPolicy = {
  repository,
  review,
  sizeLimit: reviewPolicy.sizeLimit,
};
const execution = createFactoryReviewExecution(
  policy,
  new GitHubRestAdapter({
    apiUrl: required("GITHUB_API_URL"),
    token: required("GITHUB_TOKEN"),
  }),
);

switch (phase) {
  case "preflight": {
    const decision = await execution.preflight({
      repository,
      workflowRunId: positiveInteger(required("WORKFLOW_RUN_ID"), "workflow run ID"),
    });
    if (decision.kind === "skip") {
      writeOutput("eligible", "false");
      writeOutput("reason", decision.reason);
      notice(`Factory review skipped: ${decision.reason}`);
      break;
    }
    const { ticket } = decision;
    writeOutput("eligible", "true");
    writeOutput("reason", "eligible");
    writeOutput("base_sha", ticket.baseSha);
    writeOutput("head_sha", ticket.headSha);
    writeOutput("pull_request_number", String(ticket.pullRequestNumber));
    writeOutput("ticket", Buffer.from(JSON.stringify(ticket)).toString("base64url"));
    writeOutput("provider", policy.review.provider.id);
    writeOutput("model", policy.review.provider.model);
    writeOutput("effort", policy.review.provider.effort ?? "");
    writeOutput("max_turns", String(reviewMaxTurns));
    writeOutput("output_schema", JSON.stringify(reviewOutputSchema()));
    writeOutput("output_schema_path", reviewOutputSchemaPath());
    writeOutput("prompt", renderReviewPrompt(ticket));
    break;
  }
  case "validate": {
    const adapter = providerAdapter(providerId(required("PROVIDER")));
    const output = readProviderOutput(required("REVIEW_OUTPUT_FILE"), adapter);
    const ticket = decodeTicket(required("REVIEW_TICKET"));
    const decision =
      output.failure === undefined
        ? await execution.validate({
            ticket,
            modelOutputJson: output.modelOutputJson,
          })
        : { valid: false as const, reason: output.failure.reason };
    writeOutput("valid", String(decision.valid));
    if (!decision.valid) {
      writeOutput("reason", decision.reason);
      writeOutput("failure_kind", output.failure?.kind ?? "technical");
      if (output.failure?.refillAt !== undefined) {
        writeOutput("refill_at", output.failure.refillAt);
      }
      notice(`Factory review output rejected: ${decision.reason}`);
    }
    break;
  }
  case "route": {
    const current = currentAttempt();
    const validation = attemptValidation();
    writeOutput(
      "attribution",
      Buffer.from(JSON.stringify(reviewAttributionFor(policy.review, current))).toString(
        "base64url",
      ),
    );
    const next = nextReviewAttempt(policy.review, current, validation);
    writeOutput("run_next", String(next !== null));
    if (next !== null) {
      writeOutput("next_provider", next.provider.id);
      writeOutput("next_model", next.provider.model);
      writeOutput("next_effort", next.provider.effort ?? "");
      writeOutput("next_provider_attempt", String(next.providerAttempt));
      writeOutput("next_fallback_used", String(next.fallbackUsed));
      writeOutput("next_refill_at", next.refillAt ?? "");
    }
    break;
  }
  case "publish": {
    const attribution = decodeAttribution(required("ATTRIBUTION"));
    const adapter = providerAdapter(attribution.provider);
    const output = readProviderOutput(required("REVIEW_OUTPUT_FILE"), adapter);
    const ticket = decodeTicket(required("REVIEW_TICKET"));
    let result: PublishResult;
    if (output.failure === undefined) {
      result = await execution.publish({
        ticket,
        modelOutputJson: output.modelOutputJson,
        attribution,
      });
    } else {
      await execution.fail({ ticket, reason: output.failure.reason, attribution });
      result = { outcome: "technical", conclusion: "failure" };
    }
    writeOutput("outcome", result.outcome);
    writeOutput("conclusion", result.conclusion);
    notice(`Factory review ${result.outcome}: ${result.conclusion}`);
    break;
  }
  case "fail": {
    const ticket = decodeTicket(required("REVIEW_TICKET"));
    const reason =
      optional("FAILURE_REASON") || "review workflow failed or was cancelled";
    const encodedAttribution = optional("ATTRIBUTION");
    await execution.fail(
      encodedAttribution.length === 0
        ? { ticket, reason }
        : { ticket, reason, attribution: decodeAttribution(encodedAttribution) },
    );
    break;
  }
}

function isPhase(value: string | undefined): value is Phase {
  return phases.some((candidate) => candidate === value);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment value: ${name}`);
  }
  return value;
}

function optional(name: string): string {
  return process.env[name] ?? "";
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function currentAttempt(): ReviewAttempt {
  const provider = providerFromEnvironment();
  const providerAttempt = positiveInteger(
    required("PROVIDER_ATTEMPT"),
    "provider attempt",
  );
  if (providerAttempt !== 1 && providerAttempt !== 2) {
    throw new Error("Provider attempt must be 1 or 2");
  }
  const refillAt = optional("REFILL_AT");
  const attempt: ReviewAttempt = {
    provider,
    providerAttempt,
    fallbackUsed: booleanValue(required("FALLBACK_USED"), "fallback used"),
  };
  return refillAt.length === 0 ? attempt : { ...attempt, refillAt };
}

function attemptValidation(): {
  valid: boolean;
  failureKind?: ProviderFailureKind;
  refillAt?: string;
} {
  const valid = booleanValue(required("VALID"), "validation result");
  if (valid) {
    return { valid: true };
  }
  const failureKind = providerFailureKind(required("FAILURE_KIND"));
  const refillAt = optional("VALIDATION_REFILL_AT");
  return refillAt.length === 0
    ? { valid: false, failureKind }
    : { valid: false, failureKind, refillAt };
}

function providerFromEnvironment(): ReviewProvider {
  const id = providerId(required("PROVIDER"));
  const model = required("MODEL");
  const effortValue = optional("EFFORT");
  if (id === "codex" && effortValue.length === 0) {
    throw new Error("Codex review attempt must pin reasoning effort");
  }
  if (id === "claude" && effortValue.length > 0) {
    throw new Error("Claude review attempt must not set reasoning effort");
  }
  return effortValue.length === 0
    ? { id, model }
    : { id, model, effort: reasoningEffort(effortValue) };
}

function decodeAttribution(encoded: string): ReviewAttribution {
  const value = decodeObject(encoded, "Review attribution");
  const provider = providerId(objectString(value.provider, "provider"));
  const model = objectString(value.model, "model");
  const effort = optionalEffort(value.effort);
  const fallback = optionalFallback(value.fallback);
  const attribution: ReviewAttribution =
    effort === undefined ? { provider, model } : { provider, model, effort };
  return fallback === undefined ? attribution : { ...attribution, fallback };
}

function decodeObject(encoded: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function optionalFallback(
  value: unknown,
): ReviewAttribution["fallback"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Review attribution fallback must be an object");
  }
  const fallback = value as Record<string, unknown>;
  const primaryProvider = providerId(
    objectString(fallback.primaryProvider, "fallback primaryProvider"),
  );
  const primaryModel = objectString(
    fallback.primaryModel,
    "fallback primaryModel",
  );
  const refillAt = optionalObjectString(fallback.refillAt, "fallback refillAt");
  return refillAt === undefined
    ? { primaryProvider, primaryModel }
    : { primaryProvider, primaryModel, refillAt };
}

function optionalEffort(value: unknown): ReviewReasoningEffort | undefined {
  return value === undefined ? undefined : reasoningEffort(objectString(value, "effort"));
}

function optionalObjectString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : objectString(value, field);
}

function objectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Review attribution ${field} must be a non-empty string`);
  }
  return value;
}

function providerId(value: string): ProviderId {
  if (value !== "claude" && value !== "codex") {
    throw new Error(`Unknown review provider: ${value}`);
  }
  return value;
}

function providerFailureKind(value: string): ProviderFailureKind {
  if (value !== "technical" && value !== "usage-limit") {
    throw new Error(`Unknown provider failure kind: ${value}`);
  }
  return value;
}

function reasoningEffort(value: string): ReviewReasoningEffort {
  if (!["low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error(`Unknown reasoning effort: ${value}`);
  }
  return value as ReviewReasoningEffort;
}

function booleanValue(value: string, label: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid ${label}`);
}

function notice(message: string): void {
  process.stdout.write(formatNotice(message));
}

function writeOutput(name: string, value: string): void {
  appendFileSync(required("GITHUB_OUTPUT"), formatOutput(name, value));
}

function decodeTicket(encoded: string): ReviewTicket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error("Review ticket is invalid", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Review ticket must be an object");
  }
  const value = parsed as Record<string, unknown>;
  return {
    repository: ticketString(value.repository, "repository"),
    workflowRunId: ticketInteger(value.workflowRunId, "workflowRunId"),
    pullRequestNumber: ticketInteger(value.pullRequestNumber, "pullRequestNumber"),
    baseSha: ticketString(value.baseSha, "baseSha"),
    headSha: ticketString(value.headSha, "headSha"),
    purpose: ticketString(value.purpose, "purpose"),
    checkRunId: ticketInteger(value.checkRunId, "checkRunId"),
  };
}

function ticketString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Review ticket ${field} must be a non-empty string`);
  }
  return value;
}

function ticketInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Review ticket ${field} must be a positive integer`);
  }
  return value;
}
