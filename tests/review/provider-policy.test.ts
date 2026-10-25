import { readFile } from "node:fs/promises";

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

function webRepository(fields: string): string {
  return `${header}  - id: campus-web
    ciWorkflowName: CI
    targetBranches: [dev, main]
${fields}`;
}

describe("parsePrReviewPolicy", () => {
  test("accepts the shipped policy with only campus-web in advisory", async () => {
    const source = await readFile(
      new URL("../../policies/pr-review.yaml", import.meta.url),
      "utf8",
    );

    const policy = parsePrReviewPolicy(source, registryIds, now);

    expect(policy.repositories.map((entry) => [entry.id, entry.mode])).toEqual([
      ["campus-web", "advisory"],
      ["campus-server", "disabled"],
      ["campus-mobile", "disabled"],
    ]);
  });

  test("lets a disabled repository omit credential metadata", () => {
    const policy = parsePrReviewPolicy(
      webRepository(disabledClaude),
      registryIds,
      now,
    );

    expect(policy.repositories[0]?.mode).toBe("disabled");
  });

  test("requires a credential and canary start before a repository runs reviews", () => {
    const source = webRepository(
      "    mode: advisory\n    provider: { id: claude, model: claude-opus-5-5 }\n",
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      /credential/,
    );
  });

  test("requires owner, expiry, and rotation metadata for a personal credential", () => {
    const source = webRepository(
      `${advisoryClaude}    credential: { secret: CLAUDE_CODE_OAUTH_TOKEN, ownership: personal }\n`,
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(/owner/);
  });

  test("rejects an expired personal credential", () => {
    const source = webRepository(advisoryClaude + personalCredential);

    expect(() =>
      parsePrReviewPolicy(
        source,
        registryIds,
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toThrow('Repository "campus-web" credential expired on 2027-01-01');
  });

  test("rejects a rotation date after the expiry date", () => {
    const source = webRepository(
      advisoryClaude + personalCredential.replace('"2026-12-15"', '"2027-02-01"'),
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      'Repository "campus-web" credential rotateBy must not be after expiresOn',
    );
  });

  test("rejects an unpinned model alias", () => {
    const source = webRepository(
      advisoryClaude.replace("claude-opus-5-5", "latest") + personalCredential,
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(/model/);
  });

  test("rejects a Codex provider wired to a Claude secret", () => {
    const source = webRepository(
      advisoryClaude.replaceAll(
        "id: claude, model: claude-opus-5-5",
        "id: codex, model: gpt-5.5-codex",
      ) + personalCredential,
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      /secret/,
    );
  });

  test("rejects a secret name the caller template never passes", () => {
    const source = webRepository(
      advisoryClaude +
        personalCredential.replace(
          "secret: CLAUDE_CODE_OAUTH_TOKEN",
          "secret: CLAUDE_CODE_OAUTH_TOKEN_WEB",
        ),
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      'Repository "campus-web" credential secret CLAUDE_CODE_OAUTH_TOKEN_WEB must be CLAUDE_CODE_OAUTH_TOKEN for provider claude',
    );
  });

  test("requires the canary provider before a repository runs reviews", () => {
    const source = webRepository(
      advisoryClaude.replace("    canaryProvider: { id: claude, model: claude-opus-5-5 }\n", "") +
        personalCredential,
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(/canaryProvider/);
  });

  test("rejects a provider or model change that keeps the old canary", () => {
    const source = webRepository(
      advisoryClaude.replace(
        "provider: { id: claude, model: claude-opus-5-5 }\n",
        "provider: { id: claude, model: claude-opus-5-6 }\n",
      ) + personalCredential,
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      'Repository "campus-web" provider claude/claude-opus-5-6 differs from its canary claude/claude-opus-5-5; start a new canary',
    );
  });

  test("accepts a repository whose provider matches its canary", () => {
    const policy = parsePrReviewPolicy(
      webRepository(advisoryClaude + personalCredential),
      registryIds,
      now,
    );

    expect(policy.repositories[0]?.canaryProvider).toEqual({
      id: "claude",
      model: "claude-opus-5-5",
    });
  });

  test("rejects repositories missing from the registry", () => {
    const source = webRepository(disabledClaude).replace(
      "id: campus-web",
      "id: campus-desktop",
    );

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(
      'Review policy repository "campus-desktop" is not in the repository registry',
    );
  });

  test("rejects a canary window longer than fourteen days", () => {
    const source = webRepository(disabledClaude).replace("maxDays: 14", "maxDays: 15");

    expect(() => parsePrReviewPolicy(source, registryIds, now)).toThrow(/maxDays/);
  });
});
