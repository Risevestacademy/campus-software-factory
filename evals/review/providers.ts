import {
  reviewMaxTurns,
  type RepositoryReviewPolicy,
  type ReviewProvider,
} from "../../src/review/index.ts";

export interface EvalCommandContext {
  prompt: string;
  workspace: string;
  schema: string;
  schemaPath: string;
  outputPath: string;
}

export interface EvalCommand {
  command: "claude" | "codex";
  args: string[];
  result: "stdout" | "file";
}

export function configuredEvalProviders(
  repositories: readonly RepositoryReviewPolicy[],
): ReviewProvider[] {
  const unique = new Map<string, ReviewProvider>();
  for (const repository of repositories) {
    for (const provider of [
      repository.provider,
      repository.usageLimitFallback?.provider,
    ]) {
      if (provider !== undefined) {
        unique.set(providerKey(provider), provider);
      }
    }
  }
  return [...unique.values()];
}

export function buildEvalCommand(
  provider: ReviewProvider,
  context: EvalCommandContext,
): EvalCommand {
  if (provider.id === "claude") {
    return {
      command: "claude",
      result: "stdout",
      args: [
        "-p",
        context.prompt,
        "--output-format",
        "json",
        "--model",
        provider.model,
        "--max-turns",
        String(reviewMaxTurns),
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
        context.schema,
      ],
    };
  }
  if (provider.effort === undefined) {
    throw new Error("Codex eval provider must pin reasoning effort");
  }
  return {
    command: "codex",
    result: "file",
    args: [
      "exec",
      "--model",
      provider.model,
      "--config",
      `model_reasoning_effort="${provider.effort}"`,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-schema",
      context.schemaPath,
      "--output-last-message",
      context.outputPath,
      "--cd",
      context.workspace,
      context.prompt,
    ],
  };
}

function providerKey(provider: ReviewProvider): string {
  return [provider.id, provider.model, provider.effort ?? ""].join("\0");
}
