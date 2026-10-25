import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ChangedFile, ReviewFinding } from "../../src/review/index.ts";

// Rubric v1 posted at most this many findings; a case seeding more proves none are dropped.
export const formerFindingsCap = 3;

export interface SeededDefect {
  path: string;
  lines: [number, number];
  severity: ReviewFinding["severity"];
}

export type ExpectedReview =
  | { status: "clean" }
  | { status: "findings"; defects: SeededDefect[] };

export interface ReviewCase {
  name: string;
  purpose: string;
  base: Record<string, string>;
  head: Record<string, string>;
  expect: ExpectedReview;
}

export interface ReviewWorkspace {
  root: string;
  baseSha: string;
  headSha: string;
  changedFiles: ChangedFile[];
}

const casesDirectory = new URL("./cases/", import.meta.url);

const trustedGuidance = `# Repository standards

- Behavior must match the pull request's stated purpose.
- Tests protect observable behavior, not implementation details.
`;

export function loadReviewCases(): ReviewCase[] {
  return readdirSync(casesDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) =>
      parseCase(JSON.parse(readFileSync(new URL(file, casesDirectory), "utf8")) as unknown, file),
    );
}

// Each case becomes a real two-commit repository so the reviewer sees the same
// pr/ and trusted/ layout, git history, and hunk ranges as production.
export async function buildWorkspace(reviewCase: ReviewCase): Promise<ReviewWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `factory-review-eval-${reviewCase.name}-`));
  const repository = join(root, "pr");
  await mkdir(repository);
  await writeFiles(join(root, "trusted"), { "AGENTS.md": trustedGuidance });

  git(repository, "init", "--quiet", "--initial-branch=main");
  await writeFiles(repository, reviewCase.base);
  const baseSha = commit(repository, "base");
  await writeFiles(repository, reviewCase.head);
  const headSha = commit(repository, "head");

  const changedPaths = git(repository, "diff", "--name-only", baseSha, headSha)
    .split("\n")
    .filter((path) => path.length > 0);
  return {
    root,
    baseSha,
    headSha,
    changedFiles: changedPaths.map((path) =>
      changedFile(repository, baseSha, headSha, path),
    ),
  };
}

function changedFile(
  repository: string,
  baseSha: string,
  headSha: string,
  path: string,
): ChangedFile {
  const [additions, deletions] = git(
    repository,
    "diff",
    "--numstat",
    baseSha,
    headSha,
    "--",
    path,
  ).split("\t");
  if (
    additions === undefined ||
    deletions === undefined ||
    !/^\d+$/.test(additions) ||
    !/^\d+$/.test(deletions)
  ) {
    throw new Error(`Cannot measure changed lines for ${path}`);
  }
  return {
    path,
    additions: Number(additions),
    deletions: Number(deletions),
    patch: git(repository, "diff", baseSha, headSha, "--", path),
  };
}

function git(repository: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.name=factory-eval",
      "-c", "user.email=factory-eval@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null",
      "-C", repository,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

function commit(repository: string, message: string): string {
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function parseCase(value: unknown, file: string): ReviewCase {
  const entry = requireObject(value, file);
  const expectation = requireObject(entry.expect, `${file} expect`);
  const status = expectation.status;
  let expected: ExpectedReview;
  if (status === "clean") {
    expected = { status };
  } else if (status === "findings") {
    const defects = expectation.defects;
    if (!Array.isArray(defects) || defects.length === 0) {
      throw new Error(`${file} expect.defects must be a non-empty array`);
    }
    expected = {
      status,
      defects: defects.map((defect, index) =>
        parseDefect(defect, `${file} expect.defects[${index}]`),
      ),
    };
  } else {
    throw new Error(`${file} expect.status must be "clean" or "findings"`);
  }
  return {
    name: requireString(entry.name, `${file} name`),
    purpose: requireString(entry.purpose, `${file} purpose`),
    base: requireFiles(entry.base, `${file} base`),
    head: requireFiles(entry.head, `${file} head`),
    expect: expected,
  };
}

function parseDefect(value: unknown, label: string): SeededDefect {
  const defect = requireObject(value, label);
  const lines = defect.lines;
  if (
    !Array.isArray(lines) ||
    lines.length !== 2 ||
    !lines.every((line) => Number.isSafeInteger(line) && (line as number) > 0)
  ) {
    throw new Error(`${label}.lines must be [start, end]`);
  }
  const severity = defect.severity;
  if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
    throw new Error(`${label}.severity must be "P0", "P1", or "P2"`);
  }
  return {
    path: requireString(defect.path, `${label}.path`),
    lines: [lines[0] as number, lines[1] as number],
    severity,
  };
}

function requireFiles(value: unknown, label: string): Record<string, string> {
  const files = requireObject(value, label);
  for (const [path, content] of Object.entries(files)) {
    requireString(content, `${label} ${path}`);
  }
  return files as Record<string, string>;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
