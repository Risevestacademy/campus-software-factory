import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  parseReviewResult,
  providerAdapter,
  renderReviewPrompt,
  reviewOutputSchemaPath,
  validateFindingLocations,
  type ReviewProvider,
  type ReviewResult,
} from "../../src/review/index.ts";
import { loadFactoryReviewPolicies } from "../../src/review/policy-loader.ts";
import { reviewOutputFromCli } from "./cli-output.ts";
import { findsEveryExpectedDefect, judge } from "./judge.ts";
import { buildEvalCommand, configuredEvalProviders } from "./providers.ts";
import {
  buildWorkspace,
  formerFindingsCap,
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
  allExpectedDefectsFound: boolean;
  passed: boolean;
  detail: string;
}

const schemaPath = reviewOutputSchemaPath();
const schema = await readFile(schemaPath, "utf8");
const providers = await pinnedReviewProviders();
const cases = loadReviewCases();
const providerReports = [];
for (const provider of providers) {
  providerReports.push(await scoreProvider(provider));
}
const passed = providerReports.every((report) => report.passed);
process.stdout.write(`${JSON.stringify({ passed, providers: providerReports }, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;

async function pinnedReviewProviders(): Promise<ReviewProvider[]> {
  const { policy } = await loadFactoryReviewPolicies(new Date());
  const pinned = configuredEvalProviders(policy.repositories);
  if (pinned.length === 0) {
    throw new Error("No review provider is pinned in policies/pr-review.yaml");
  }
  return pinned;
}

async function scoreProvider(provider: ReviewProvider) {
  const scores: CaseScore[] = [];
  for (const reviewCase of cases) {
    scores.push(await scoreCase(reviewCase, provider));
  }
  const passedCount = scores.filter((score) => score.passed).length;
  const cleanCasesSilent = scores
    .filter((score) => score.expected.status === "clean")
    .every((score) => score.passed);
  const uncappedCasesComplete = scores
    .filter(
      (score) =>
        score.expected.status === "findings" &&
        score.expected.defects.length > formerFindingsCap,
    )
    .every((score) => score.allExpectedDefectsFound);
  const score = passedCount / scores.length;
  return {
    provider,
    score,
    passThreshold,
    cleanCasesSilent,
    uncappedCasesComplete,
    passed: score >= passThreshold && cleanCasesSilent && uncappedCasesComplete,
    cases: scores,
  };
}

async function scoreCase(
  reviewCase: ReviewCase,
  provider: ReviewProvider,
): Promise<CaseScore> {
  const workspace = await buildWorkspace(reviewCase);
  try {
    const result = await review(reviewCase, workspace, provider);
    return {
      name: reviewCase.name,
      expected: reviewCase.expect,
      allExpectedDefectsFound: findsEveryExpectedDefect(reviewCase.expect, result),
      ...judge(reviewCase.expect, result),
    };
  } catch (error: unknown) {
    return {
      name: reviewCase.name,
      expected: reviewCase.expect,
      allExpectedDefectsFound: false,
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
  provider: ReviewProvider,
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
  const outputPath = join(workspace.root, "provider-output.json");
  const invocation = buildEvalCommand(provider, {
    prompt,
    workspace: workspace.root,
    schema,
    schemaPath,
    outputPath,
  });
  const pending = run(
    invocation.command,
    invocation.args,
    { cwd: workspace.root, timeout: caseTimeoutMilliseconds, maxBuffer: 16 * 1024 * 1024 },
  );
  pending.child.stdin?.end();
  const { stdout } = await pending;
  const rawOutput =
    invocation.result === "stdout" ? stdout : await readFile(outputPath, "utf8");
  const modelOutput =
    provider.id === "claude"
      ? reviewOutputFromCli(rawOutput)
      : providerAdapter(provider.id).outputFrom(rawOutput);
  const result = parseReviewResult(modelOutput);
  if (result.status === "findings") {
    validateFindingLocations(result.findings, workspace.changedFiles);
  }
  return result;
}
