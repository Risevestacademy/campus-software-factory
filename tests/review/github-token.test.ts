import { describe, expect, test, vi } from "vitest";

import { resolveGitHubToken } from "../../src/review/github-token.js";

describe("resolveGitHubToken", () => {
  test("prefers GITHUB_TOKEN over the gh login", async () => {
    const readGhLoginToken = vi.fn(async () => "gh-token\n");

    await expect(
      resolveGitHubToken({ GITHUB_TOKEN: "env-token" }, readGhLoginToken),
    ).resolves.toBe("env-token");
    expect(readGhLoginToken).not.toHaveBeenCalled();
  });

  test("falls back to the gh login token without its trailing newline", async () => {
    await expect(
      resolveGitHubToken({ GITHUB_TOKEN: "" }, async () => "gh-token\n"),
    ).resolves.toBe("gh-token");
  });

  test("names both token sources when neither has a token", async () => {
    await expect(resolveGitHubToken({}, async () => "")).rejects.toThrow(
      "No GitHub token: set GITHUB_TOKEN or run gh auth login",
    );
  });
});
