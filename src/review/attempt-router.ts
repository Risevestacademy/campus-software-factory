import type { RepositoryReviewPolicy, ReviewProvider } from "./provider-policy.ts";
import type { ProviderFailureKind } from "./providers/adapter.ts";
import type { ReviewAttribution } from "./execution.ts";

export interface ReviewAttempt {
  provider: ReviewProvider;
  providerAttempt: 1 | 2;
  fallbackUsed: boolean;
  refillAt?: string;
}

export interface ReviewAttemptValidation {
  valid: boolean;
  failureKind?: ProviderFailureKind;
  refillAt?: string;
}

export function nextReviewAttempt(
  policy: RepositoryReviewPolicy,
  current: ReviewAttempt,
  validation: ReviewAttemptValidation,
): ReviewAttempt | null {
  if (validation.valid) {
    return null;
  }

  const refillAt = validation.refillAt ?? current.refillAt;
  const fallback = policy.usageLimitFallback;
  if (
    validation.failureKind === "usage-limit" &&
    current.provider.id === "claude" &&
    !current.fallbackUsed &&
    fallback !== undefined
  ) {
    return withRefill(
      {
        provider: fallback.provider,
        providerAttempt: 1,
        fallbackUsed: true,
      },
      refillAt,
    );
  }

  return current.providerAttempt === 1
    ? withRefill({ ...current, providerAttempt: 2 }, refillAt)
    : null;
}

export function reviewAttributionFor(
  policy: RepositoryReviewPolicy,
  attempt: ReviewAttempt,
): ReviewAttribution {
  const reviewer: ReviewAttribution =
    attempt.provider.effort === undefined
      ? { provider: attempt.provider.id, model: attempt.provider.model }
      : {
          provider: attempt.provider.id,
          model: attempt.provider.model,
          effort: attempt.provider.effort,
        };
  if (!attempt.fallbackUsed) {
    return reviewer;
  }
  const fallback = {
    primaryProvider: policy.provider.id,
    primaryModel: policy.provider.model,
  };
  return {
    ...reviewer,
    fallback:
      attempt.refillAt === undefined
        ? fallback
        : { ...fallback, refillAt: attempt.refillAt },
  };
}

function withRefill(attempt: ReviewAttempt, refillAt: string | undefined): ReviewAttempt {
  return refillAt === undefined ? attempt : { ...attempt, refillAt };
}
