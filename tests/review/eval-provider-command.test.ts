import { describe, expect, test } from "vitest";

import {
  buildEvalCommand,
  configuredEvalProviders,
} from "../../evals/review/providers.js";
import type { RepositoryReviewPolicy } from "../../src/review/index.js";

const fallbackPolicy: RepositoryReviewPolicy = {
  id: "campus-web",
  mode: "advisory",
  ciWorkflowName: "CI",
  targetBranches: ["dev", "main"],
  provider: { id: "claude", model: "claude-opus-5-5" },
  usageLimitFallback: {
    provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
    canaryProvider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
    credential: { secret: "OPENAI_API_KEY", ownership: "personal" },
  },
};

const commandContext = {
  prompt: "Review this pull request",
  workspace: "/tmp/review-eval",
  schema: '{"type":"object"}',
  schemaPath: "/factory/review-output.schema.json",
  outputPath: "/tmp/review-eval/provider-output.json",
};

describe("configuredEvalProviders", () => {
  test("evaluates each unique primary and usage-limit fallback configuration", () => {
    expect(configuredEvalProviders([fallbackPolicy, fallbackPolicy])).toEqual([
      { id: "claude", model: "claude-opus-5-5" },
      { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
    ]);
  });
});

describe("buildEvalCommand", () => {
  test("preserves the production Claude model, turn budget, and schema", () => {
    const invocation = buildEvalCommand(fallbackPolicy.provider, commandContext);

    expect(invocation.command).toBe("claude");
    expect(invocation.result).toBe("stdout");
    expect(invocation.args).toContain("claude-opus-5-5");
    expect(invocation.args).toContain("--max-turns");
    expect(invocation.args).toContain('{"type":"object"}');
  });

  test("runs Codex read-only with the policy-pinned model and effort", () => {
    const invocation = buildEvalCommand(
      fallbackPolicy.usageLimitFallback!.provider,
      commandContext,
    );

    expect(invocation).toMatchObject({
      command: "codex",
      result: "file",
    });
    expect(invocation.args).toContain("gpt-6.1-sol");
    expect(invocation.args).toContain('model_reasoning_effort="medium"');
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain(commandContext.schemaPath);
    expect(invocation.args).toContain(commandContext.outputPath);
  });
});
