import type { ReviewProviderAdapter } from "./adapter.ts";

interface SdkResultMessage {
  type: "result";
  subtype?: unknown;
  is_error?: unknown;
  num_turns?: unknown;
  result?: unknown;
  structured_output?: unknown;
}

// claude-code-action writes every SDK message to its execution file and trusts
// structured_output only on a successful final result. This mirrors that rule.
export const claudeAdapter: ReviewProviderAdapter = {
  id: "claude",
  outputFrom(executionFile) {
    const result = finalResult(executionFile);
    return result?.subtype === "success" &&
      result.is_error !== true &&
      result.structured_output !== undefined
      ? JSON.stringify(result.structured_output)
      : "";
  },
  failureFrom(executionFile) {
    const result = finalResult(executionFile);
    if (result?.is_error !== true) {
      return undefined;
    }
    if (
      result.subtype === "error_max_turns" &&
      typeof result.num_turns === "number" &&
      Number.isSafeInteger(result.num_turns)
    ) {
      return `Claude stopped: error_max_turns after ${result.num_turns} turns`;
    }
    const detail =
      typeof result.result === "string" && result.result.trim().length > 0
        ? result.result.trim()
        : "unknown error";
    return `Claude reported an error: ${detail}`;
  },
};

function finalResult(executionFile: string): SdkResultMessage | undefined {
  let messages: unknown;
  try {
    messages = JSON.parse(executionFile) as unknown;
  } catch {
    return undefined;
  }
  return Array.isArray(messages) ? messages.findLast(isResultMessage) : undefined;
}

function isResultMessage(message: unknown): message is SdkResultMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "result"
  );
}
