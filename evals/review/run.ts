import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

import {
  parseReviewResult,
  providerAdapter,
  renderReviewPrompt,
  reviewOutputSchemaPath,
  validateFindingLocations,
  type ReviewResult,
} from "../../src/review/index.ts";
import { loadFactoryReviewPolicies } from "../../src/review/policy-loader.ts";
import { judge } from "./judge.ts";
import {
  buildWorkspace,
  loadReviewCases,
  type ReviewCase,
  type ReviewWorkspace,
} from "./workspace.ts";

const run = promisify(execFile);
const passThreshold = 0.75;
const caseTimeoutMilliseconds = 10 * 60 * 1_000;

interface CaseScore {
  name: string;
  expected: ReviewCase["expect"];
  passed: boolean;
  detail: string;
}

const schema = await readFile(reviewOutputSchemaPath(), "utf8");
const models = await pinnedClaudeModels();
const cases = loadReviewCases();
const modelReports = [];
for (const model of models) {
  modelReports.push(await scoreModel(model));
}
const passed = modelReports.every((report) => report.passed);
process.stdout.write(`${JSON.stringify({ passed, models: modelReports }, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;

async function pinnedClaudeModels(): Promise<string[]> {
  const { policy } = await loadFactoryReviewPolicies(new Date());
  const pinned = new Set(
    policy.repositories
      .filter((repository) => repository.provider.id === "claude")
      .map((repository) => repository.provider.model),
  );
  if (pinned.size === 0) {
    throw new Error("No repository in policies/pr-review.yaml pins a Claude model");
  }
  return [...pinned];
}

async function scoreModel(model: string) {
  const scores: CaseScore[] = [];
  for (const reviewCase of cases) {
    scores.push(await scoreCase(reviewCase, model));
  }
  const passedCount = scores.filter((score) => score.passed).length;
  const cleanCasesSilent = scores
    .filter((score) => score.expected.status === "clean")
    .every((score) => score.passed);
  const score = passedCount / scores.length;
  return {
    model,
    score,
    passThreshold,
    cleanCasesSilent,
    passed: score >= passThreshold && cleanCasesSilent,
    cases: scores,
  };
}

async function scoreCase(reviewCase: ReviewCase, model: string): Promise<CaseScore> {
  const workspace = await buildWorkspace(reviewCase);
  try {
    const result = await review(reviewCase, workspace, model);
    return { name: reviewCase.name, expected: reviewCase.expect, ...judge(reviewCase.expect, result) };
  } catch (error: unknown) {
    return {
      name: reviewCase.name,
      expected: reviewCase.expect,
      passed: false,
      detail: `invalid review: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

async function review(
  reviewCase: ReviewCase,
  workspace: ReviewWorkspace,
  model: string,
): Promise<ReviewResult> {
  const prompt = renderReviewPrompt({
    repository: "factory-eval/review",
    workflowRunId: 1,
    pullRequestNumber: 1,
    baseSha: workspace.baseSha,
    headSha: workspace.headSha,
    purpose: reviewCase.purpose,
    checkRunId: 1,
  });
  const { stdout } = await run(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      model,
      "--max-turns",
      "12",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Skill",
      "Bash(git -C pr diff:*)",
      "Bash(git -C pr show:*)",
      "Bash(git -C pr log:*)",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "--json-schema",
      schema,
    ],
    { cwd: workspace.root, timeout: caseTimeoutMilliseconds, maxBuffer: 16 * 1024 * 1024 },
  );
  const envelope = JSON.parse(stdout) as { structured_output?: unknown; result?: unknown };
  const raw =
    envelope.structured_output === undefined
      ? String(envelope.result ?? "")
      : JSON.stringify(envelope.structured_output);
  const result = parseReviewResult(providerAdapter("claude").outputFrom(raw));
  if (result.status === "findings") {
    validateFindingLocations(result.findings, workspace.changedFiles);
  }
  return result;
}
