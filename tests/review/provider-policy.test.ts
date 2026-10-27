import { describe, expect, test } from "vitest";

import { parsePrReviewPolicy } from "../../src/review/index.js";

const registryIds = ["campus-web", "campus-server", "campus-mobile"];
const now = new Date("2026-10-25T00:00:00.000Z");

const header = `version: 1
checkName: Factory PR Review
rubric: { version: 2, maxFindings: 50, minimumConfidence: 0.9 }
sizeLimit: { maxChangedLines: 400, maxChangedFiles: 15, excludedPaths: [pnpm-lock.yaml, package-lock.json, yarn.lock] }
canary: { minimumPullRequests: 10, maxDays: 14, maxFalsePositives: 1, maxTechnicalErrorRate: 0.05, maxP95LatencyMinutes: 10 }
repositories:
`;

const personalCredential = `    credential:
      secret: CLAUDE_CODE_OAUTH_TOKEN
      ownership: personal
      owner: aj1732
      expiresOn: "2027-01-01"
      rotateBy: "2026-12-15"
`;

const advisoryClaude = `    mode: advisory
    canaryStartsAt: "2026-10-25T09:00:00Z"
    provider: { id: claude, model: claude-opus-5-5 }
    canaryProvider: { id: claude, model: claude-opus-5-5 }
`;

const disabledClaude = `    mode: disabled
    provider: { id: claude, model: claude-opus-5-5 }
`;

const codexFallback = `    usageLimitFallback:
      provider: { id: codex, model: gpt-6.1-sol, effort: medium }
      canaryProvider: { id: codex, model: gpt-6.1-sol, effort: medium }
      credential:
        secret: OPENAI_API_KEY
        ownership: personal
        owner: aj1732
        expiresOn: "2027-01-01"
        rotateBy: "2026-12-15"
`;

function webRepository(fields: string): string {
  return `${header}  - id: campus-web
    ciWorkflowName: CI
    targetBranches: [dev, main]
${fields}`;
}

const codexPrimary = advisoryClaude.replaceAll(
  "id: claude, model: claude-opus-5-5",
  "id: codex, model: gpt-6.1-sol, effort: medium",
);

describe("parsePrReviewPolicy", () => {
  test("lets a disabled repository omit credential metadata", () => {
    const policy = parsePrReviewPolicy(webRepository(disabledClaude), registryIds, now);

    expect(policy.repositories[0]?.mode).toBe("disabled");
  });

  test("accepts a canary-pinned provider with a canary-pinned Codex fallback", () => {
    const policy = parsePrReviewPolicy(
      webRepository(advisoryClaude + personalCredential + codexFallback),
      registryIds,
      now,
    );

    expect(policy.repositories[0]?.canaryProvider).toEqual({
      id: "claude",
      model: "claude-opus-5-5",
    });
    expect(policy.repositories[0]?.usageLimitFallback).toEqual({
      provider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
      canaryProvider: { id: "codex", model: "gpt-6.1-sol", effort: "medium" },
      credential: {
        secret: "OPENAI_API_KEY",
        ownership: "personal",
        owner: "aj1732",
        expiresOn: "2027-01-01",
        rotateBy: "2026-12-15",
      },
    });
  });

  test.each<{ name: string; source: string; error: string | RegExp; at?: Date }>([
    {
      name: "a reviewing repository without a credential",
      source: webRepository("    mode: advisory\n    provider: { id: claude, model: claude-opus-5-5 }\n"),
      error: /credential/,
    },
    {
      name: "a personal credential without owner, expiry, and rotation",
      source: webRepository(
        `${advisoryClaude}    credential: { secret: CLAUDE_CODE_OAUTH_TOKEN, ownership: personal }\n`,
      ),
      error: /owner/,
    },
    {
      name: "an expired personal credential",
      source: webRepository(advisoryClaude + personalCredential),
      error: 'Repository "campus-web" credential expired on 2027-01-01',
      at: new Date("2027-01-01T00:00:00.000Z"),
    },
    {
      name: "a rotation date after the expiry date",
      source: webRepository(
        advisoryClaude + personalCredential.replace('"2026-12-15"', '"2027-02-01"'),
      ),
      error: 'Repository "campus-web" credential rotateBy must not be after expiresOn',
    },
    {
      name: "an unpinned model alias",
      source: webRepository(advisoryClaude.replace("claude-opus-5-5", "latest") + personalCredential),
      error: /model/,
    },
    {
      name: "a Codex provider wired to a Claude secret",
      source: webRepository(codexPrimary + personalCredential),
      error: /secret/,
    },
    {
      name: "a secret name the caller template never passes",
      source: webRepository(
        advisoryClaude +
          personalCredential.replace("secret: CLAUDE_CODE_OAUTH_TOKEN", "secret: CLAUDE_CODE_OAUTH_TOKEN_WEB"),
      ),
      error:
        'Repository "campus-web" credential secret CLAUDE_CODE_OAUTH_TOKEN_WEB must be CLAUDE_CODE_OAUTH_TOKEN for provider claude',
    },
    {
      name: "a reviewing repository without a canary provider",
      source: webRepository(
        advisoryClaude.replace("    canaryProvider: { id: claude, model: claude-opus-5-5 }\n", "") +
          personalCredential,
      ),
      error: /canaryProvider/,
    },
    {
      name: "a provider or model change that keeps the old canary",
      source: webRepository(
        advisoryClaude.replace(
          "provider: { id: claude, model: claude-opus-5-5 }\n",
          "provider: { id: claude, model: claude-opus-5-6 }\n",
        ) + personalCredential,
      ),
      error:
        'Repository "campus-web" provider claude/claude-opus-5-6 differs from its canary claude/claude-opus-5-5; start a new canary',
    },
    {
      name: "a usage-limit fallback when Claude is not the primary provider",
      source: webRepository(
        codexPrimary +
          personalCredential.replace("CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY") +
          codexFallback,
      ),
      error: 'Repository "campus-web" usage-limit fallback requires Claude as the primary provider',
    },
    {
      name: "a usage-limit fallback that does not use Codex",
      source: webRepository(
        advisoryClaude +
          personalCredential +
          codexFallback.replaceAll(
            "id: codex, model: gpt-6.1-sol, effort: medium",
            "id: claude, model: claude-opus-5-5",
          ),
      ),
      error: 'Repository "campus-web" usage-limit fallback provider must be Codex',
    },
    {
      name: "a fallback model or effort change that keeps the old canary",
      source: webRepository(
        advisoryClaude +
          personalCredential +
          codexFallback.replace(
            "provider: { id: codex, model: gpt-6.1-sol, effort: medium }",
            "provider: { id: codex, model: gpt-6.1-sol, effort: xhigh }",
          ),
      ),
      error:
        'Repository "campus-web" usage-limit fallback codex/gpt-6.1-sol/xhigh differs from its canary codex/gpt-6.1-sol/medium; start a new canary',
    },
    {
      name: "a fallback wired to the wrong credential secret",
      source: webRepository(
        advisoryClaude +
          personalCredential +
          codexFallback.replace("secret: OPENAI_API_KEY", "secret: CLAUDE_CODE_OAUTH_TOKEN"),
      ),
      error:
        'Repository "campus-web" usage-limit fallback credential secret CLAUDE_CODE_OAUTH_TOKEN must be OPENAI_API_KEY for provider codex',
    },
    {
      name: "a Codex provider without explicit reasoning effort",
      source: webRepository(
        advisoryClaude + personalCredential + codexFallback.replaceAll(", effort: medium", ""),
      ),
      error:
        'Repository "campus-web" usage-limit fallback provider codex/gpt-6.1-sol must pin reasoning effort',
    },
    {
      name: "a repository missing from the registry",
      source: webRepository(disabledClaude).replace("id: campus-web", "id: campus-desktop"),
      error: 'Review policy repository "campus-desktop" is not in the repository registry',
    },
    {
      name: "a canary window longer than fourteen days",
      source: webRepository(disabledClaude).replace("maxDays: 14", "maxDays: 15"),
      error: /maxDays/,
    },
  ])("rejects $name", ({ source, error, at }) => {
    expect(() => parsePrReviewPolicy(source, registryIds, at ?? now)).toThrow(error);
  });
});
