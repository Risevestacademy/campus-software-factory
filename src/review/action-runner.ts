import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { GitHubRestAdapter } from "./github-rest-adapter.ts";
import {
  createClaudeReviewExecution,
  type ReviewPolicy,
  type ReviewTicket,
} from "./index.ts";

const phase = process.argv[2];
if (phase !== "preflight" && phase !== "publish") {
  throw new Error('Review action phase must be "preflight" or "publish"');
}

const policy: ReviewPolicy = {
  allowedRepository: required("ALLOWED_REPOSITORY"),
  ciWorkflowName: required("CI_WORKFLOW_NAME"),
  canaryStartsAt: required("CANARY_STARTS_AT"),
  canaryEndsAt: required("CANARY_ENDS_AT"),
};
const github = new GitHubRestAdapter({
  apiUrl: required("GITHUB_API_URL"),
  token: required("GITHUB_TOKEN"),
});
const execution = createClaudeReviewExecution(policy, github);

if (phase === "preflight") {
  const decision = await execution.preflight({
    repository: required("REPOSITORY"),
    workflowRunId: positiveInteger(required("WORKFLOW_RUN_ID"), "workflow run ID"),
    observedAt: new Date(),
  });
  if (decision.kind === "skip") {
    writeOutput("eligible", "false");
    writeOutput("reason", decision.reason);
    process.stdout.write(`::notice::Claude review skipped: ${decision.reason}\n`);
  } else {
    const { ticket } = decision;
    writeOutput("eligible", "true");
    writeOutput("reason", "eligible");
    writeOutput("base_sha", ticket.baseSha);
    writeOutput("head_sha", ticket.headSha);
    writeOutput("pull_request_number", String(ticket.pullRequestNumber));
    writeOutput("claim_name", ticket.claimName);
    writeOutput("ticket", Buffer.from(JSON.stringify(ticket)).toString("base64url"));
    writeMultilineOutput("purpose", ticket.purpose);
  }
} else {
  const decision = await execution.publish({
    ticket: decodeTicket(required("REVIEW_TICKET")),
    modelOutputJson: required("REVIEW_JSON"),
    observedAt: new Date(),
  });
  writeOutput("reviewed", decision.kind === "published" ? "true" : "false");
  writeOutput("reason", decision.reason);
  process.stdout.write(
    `::notice::Claude review ${decision.kind === "published" ? "published" : "skipped"}: ${decision.reason}\n`,
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment value: ${name}`);
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function writeOutput(name: string, value: string): void {
  appendFileSync(required("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

function writeMultilineOutput(name: string, value: string): void {
  const delimiter = `campus_${randomUUID()}`;
  appendFileSync(
    required("GITHUB_OUTPUT"),
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
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
    pullRequestNumber: ticketInteger(
      value.pullRequestNumber,
      "pullRequestNumber",
    ),
    baseSha: ticketString(value.baseSha, "baseSha"),
    headSha: ticketString(value.headSha, "headSha"),
    purpose: ticketString(value.purpose, "purpose"),
    claimName: ticketString(value.claimName, "claimName"),
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
