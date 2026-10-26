import { describe, expect, test } from "vitest";

import {
  nextReviewAttempt,
  reviewAttributionFor,
} from "../../src/review/attempt-router.js";
import type { RepositoryReviewPolicy } from "../../src/review/index.js";

const policy: RepositoryReviewPolicy = {
  id: "campus-web",
  mode: "advisory",
  ciWorkflowName: "CI",
  targetBranches: ["dev", "main"],
  provider: { id: "claude", model: "claude-opus-5-5" },
  canaryStartsAt: "2026-10-25T12:00:00Z",
  canaryProvider: { id: "claude", model: "claude-opus-5-5" },
  credential: { secret: "CLAUDE_CODE_OAUTH_TOKEN", ownership: "organization" },
  usageLimitFallback: {
    provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
    canaryProvider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
    credential: { secret: "OPENAI_API_KEY", ownership: "organization" },
  },
};

const firstClaudeAttempt = {
  provider: policy.provider,
  providerAttempt: 1 as const,
  fallbackUsed: false,
};

describe("nextReviewAttempt", () => {
  test("routes Claude usage exhaustion to the first Codex fallback attempt", () => {
    expect(
      nextReviewAttempt(policy, firstClaudeAttempt, {
        valid: false,
        failureKind: "usage-limit",
        refillAt: "3:00 PM (Africa/Lagos)",
      }),
    ).toEqual({
      provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
      providerAttempt: 1,
      fallbackUsed: true,
      refillAt: "3:00 PM (Africa/Lagos)",
    });
  });

  test("falls back when Claude omits its refill time", () => {
    expect(
      nextReviewAttempt(policy, firstClaudeAttempt, {
        valid: false,
        failureKind: "usage-limit",
      }),
    ).toEqual({
      provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
      providerAttempt: 1,
      fallbackUsed: true,
    });
  });

  test("retries the primary provider after an ordinary technical failure", () => {
    expect(
      nextReviewAttempt(policy, firstClaudeAttempt, {
        valid: false,
        failureKind: "technical",
      }),
    ).toEqual({
      provider: { id: "claude", model: "claude-opus-5-5" },
      providerAttempt: 2,
      fallbackUsed: false,
    });
  });

  test("can fall back when the second Claude attempt exhausts usage", () => {
    expect(
      nextReviewAttempt(
        policy,
        { ...firstClaudeAttempt, providerAttempt: 2 },
        { valid: false, failureKind: "usage-limit", refillAt: "tomorrow at 9:00 AM" },
      ),
    ).toEqual({
      provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
      providerAttempt: 1,
      fallbackUsed: true,
      refillAt: "tomorrow at 9:00 AM",
    });
  });

  test("retries Codex fallback once while preserving Claude refill information", () => {
    const firstCodexAttempt = {
      provider: policy.usageLimitFallback!.provider,
      providerAttempt: 1 as const,
      fallbackUsed: true,
      refillAt: "3:00 PM (Africa/Lagos)",
    };

    expect(
      nextReviewAttempt(policy, firstCodexAttempt, {
        valid: false,
        failureKind: "technical",
      }),
    ).toEqual({
      ...firstCodexAttempt,
      providerAttempt: 2,
    });
  });

  test("stops after a provider's second failed attempt", () => {
    expect(
      nextReviewAttempt(
        policy,
        { ...firstClaudeAttempt, providerAttempt: 2 },
        { valid: false, failureKind: "technical" },
      ),
    ).toBeNull();
  });

  test("stops after valid output", () => {
    expect(
      nextReviewAttempt(policy, firstClaudeAttempt, { valid: true }),
    ).toBeNull();
  });
});

describe("reviewAttributionFor", () => {
  test("attributes a primary attempt without fallback metadata", () => {
    expect(reviewAttributionFor(policy, firstClaudeAttempt)).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
    });
  });

  test("attributes a Codex fallback and preserves Claude refill time", () => {
    expect(
      reviewAttributionFor(policy, {
        provider: policy.usageLimitFallback!.provider,
        providerAttempt: 2,
        fallbackUsed: true,
        refillAt: "3:00 PM (Africa/Lagos)",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "medium",
      fallback: {
        primaryProvider: "claude",
        primaryModel: "claude-opus-5-5",
        refillAt: "3:00 PM (Africa/Lagos)",
      },
    });
  });
});
