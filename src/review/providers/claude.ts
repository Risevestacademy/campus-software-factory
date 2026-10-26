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
      return {
        kind: "technical",
        reason: `Claude stopped: error_max_turns after ${result.num_turns} turns`,
      };
    }
    const detail =
      typeof result.result === "string" && result.result.trim().length > 0
        ? result.result.trim()
        : "unknown error";
    const reason = `Claude reported an error: ${detail}`;
    if (!isUsageLimit(detail)) {
      return { kind: "technical", reason };
    }
    const refillAt = usageLimitRefillAt(detail);
    return refillAt === undefined
      ? { kind: "usage-limit", reason }
      : { kind: "usage-limit", reason, refillAt };
  },
};

function isUsageLimit(detail: string): boolean {
  return (
    !/not your usage limit/i.test(detail) &&
    (/you(?:'ve| have) (?:hit|reached) your (?:(?:session|weekly|monthly|usage) )?limit\b/i.test(
      detail,
    ) ||
      /usage limit reached/i.test(detail) ||
      /limit reached[^\n]*resets?\b/i.test(detail))
  );
}

function usageLimitRefillAt(detail: string): string | undefined {
  const refill =
    /\b(?:resets?|refills?)\s+(?:(?:at|on|in)\s+)?([^\n.]{1,120}?)(?=\s+\((?:error type|request id|model sent)\b|[.\n]|$)/i.exec(
      detail,
    )?.[1];
  return refill?.trim();
}

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
