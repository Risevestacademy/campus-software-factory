import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../.github/actions/factory-pr-review/keep-output.sh", import.meta.url),
);

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keep-output-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function keep(provider: string, source: string): string {
  const target = join(directory, "review-output");
  execFileSync("bash", [script], {
    env: {
      PATH: process.env.PATH,
      PROVIDER: provider,
      CLAUDE_FILE: provider === "claude" ? source : "",
      CODEX_FILE: join(directory, "codex-output.txt"),
      REVIEW_OUTPUT_FILE: target,
    },
  });
  return target;
}

function providerFile(name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

describe("keep-output.sh", () => {
  test.each(["claude", "codex"])("moves a %s attempt's file into place", (provider) => {
    const source = providerFile(
      provider === "claude" ? "claude-execution-output.json" : "codex-output.txt",
      "output",
    );

    const target = keep(provider, source);

    expect(readFileSync(target, "utf8")).toBe("output");
    expect(existsSync(source)).toBe(false);
  });

  test("keeps a failed attempt's file so its reason can be diagnosed", () => {
    const source = providerFile("claude-execution-output.json", "error result");

    const target = keep("claude", source);

    expect(existsSync(target)).toBe(true);
    expect(existsSync(source)).toBe(false);
  });

  test("clears an earlier output when the attempt wrote no file", () => {
    const earlier = providerFile("review-output", "earlier");

    const target = keep("claude", "");

    expect(target).toBe(earlier);
    expect(existsSync(target)).toBe(false);
  });

  test("rejects an unknown provider", () => {

    expect(() => keep("other", "")).toThrow();
  });
});
