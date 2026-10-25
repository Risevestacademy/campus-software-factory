import { appendFileSync } from "node:fs";

import { formatNotice, formatOutput } from "./github-output.ts";
import { GitHubRestAdapter } from "./github-rest-adapter.ts";
import { loadRepositoryReview } from "./policy-loader.ts";
import {
  createFactoryReviewExecution,
  providerAdapter,
  readProviderOutput,
  renderReviewPrompt,
  reviewMaxTurns,
  reviewOutputSchema,
  reviewOutputSchemaPath,
  type ExecutionPolicy,
  type PublishResult,
  type ReviewTicket,
} from "./index.ts";

const phases = ["preflight", "validate", "publish", "fail"] as const;
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
const adapter = providerAdapter(policy.review.provider.id);
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
    writeOutput("max_turns", String(reviewMaxTurns));
    writeOutput("output_schema", JSON.stringify(reviewOutputSchema()));
    writeOutput("output_schema_path", reviewOutputSchemaPath());
    writeOutput("prompt", renderReviewPrompt(ticket));
    break;
  }
  case "validate": {
    const output = readProviderOutput(required("REVIEW_OUTPUT_FILE"), adapter);
    const ticket = decodeTicket(required("REVIEW_TICKET"));
    const decision =
      output.failureReason === undefined
        ? await execution.validate({
            ticket,
            modelOutputJson: output.modelOutputJson,
          })
        : { valid: false as const, reason: output.failureReason };
    writeOutput("valid", String(decision.valid));
    if (!decision.valid) {
      writeOutput("reason", decision.reason);
      notice(`Factory review output rejected: ${decision.reason}`);
    }
    break;
  }
  case "publish": {
    const output = readProviderOutput(required("REVIEW_OUTPUT_FILE"), adapter);
    const ticket = decodeTicket(required("REVIEW_TICKET"));
    let result: PublishResult;
    if (output.failureReason === undefined) {
      result = await execution.publish({
        ticket,
        modelOutputJson: output.modelOutputJson,
      });
    } else {
      await execution.fail({ ticket, reason: output.failureReason });
      result = { outcome: "technical", conclusion: "failure" };
    }
    writeOutput("outcome", result.outcome);
    writeOutput("conclusion", result.conclusion);
    notice(`Factory review ${result.outcome}: ${result.conclusion}`);
    break;
  }
  case "fail": {
    await execution.fail({
      ticket: decodeTicket(required("REVIEW_TICKET")),
      reason: optional("FAILURE_REASON") || "review workflow failed or was cancelled",
    });
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
