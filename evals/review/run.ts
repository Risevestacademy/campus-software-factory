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
import {
  buildWorkspace,
  loadReviewCases,
  type ReviewCase,
  type ReviewWorkspace,
} from "./workspace.ts";

const run = promisify(execFile);
const model = "claude-opus-5-5";
const passThreshold = 0.75;
const caseTimeoutMilliseconds = 10 * 60 * 1_000;

interface CaseScore {
  name: string;
  expected: ReviewCase["expect"];
  passed: boolean;
  detail: string;
}

const schema = await readFile(reviewOutputSchemaPath(), "utf8");
const scores: CaseScore[] = [];
for (const reviewCase of loadReviewCases()) {
  scores.push(await scoreCase(reviewCase));
}

const passedCount = scores.filter((score) => score.passed).length;
const cleanCasesSilent = scores
  .filter((score) => score.expected.status === "clean")
  .every((score) => score.passed);
const score = passedCount / scores.length;
const passed = score >= passThreshold && cleanCasesSilent;
process.stdout.write(
  `${JSON.stringify({ model, score, passThreshold, cleanCasesSilent, passed, cases: scores }, null, 2)}\n`,
);
process.exitCode = passed ? 0 : 1;

async function scoreCase(reviewCase: ReviewCase): Promise<CaseScore> {
  const workspace = await buildWorkspace(reviewCase);
  try {
    const result = await review(reviewCase, workspace);
    return { name: reviewCase.name, expected: reviewCase.expect, ...judge(reviewCase, result) };
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

function judge(
  reviewCase: ReviewCase,
  result: ReviewResult,
): Pick<CaseScore, "passed" | "detail"> {
  const expected = reviewCase.expect;
  if (expected.status === "clean") {
    return result.status === "clean"
      ? { passed: true, detail: "silent as expected" }
      : { passed: false, detail: `expected clean, got ${result.status}: ${summarize(result)}` };
  }
  const hit = result.findings.some(
    (finding) =>
      finding.path === expected.path &&
      finding.line >= expected.lines[0] &&
      finding.line <= expected.lines[1],
  );
  return hit
    ? { passed: true, detail: `found defect at ${expected.path}:${expected.lines.join("-")}` }
    : { passed: false, detail: `missed ${expected.path}:${expected.lines.join("-")}; got ${summarize(result)}` };
}

function summarize(result: ReviewResult): string {
  return result.findings.length === 0
    ? result.status
    : result.findings.map((finding) => `${finding.path}:${finding.line} ${finding.title}`).join("; ");
}
