import { describe, expect, test, vi } from "vitest";

import { GitHubRestAdapter } from "../../src/review/github-rest-adapter.js";

describe("GitHubRestAdapter", () => {
  test("paginates reviews so a marker after the first 100 remains visible", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({ body: `review-${index}` })),
          '<https://api.github.com/page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ body: "<!-- campus-claude-review:abc -->" }]),
      );
    const adapter = new GitHubRestAdapter({
      apiUrl: "https://api.github.com",
      token: "token",
      fetcher,
    });

    await expect(
      adapter.listReviewBodies("rise/campus-web", 21),
    ).resolves.toContain("<!-- campus-claude-review:abc -->");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("finds a durable invocation claim on a later artifact page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { artifacts: Array.from({ length: 100 }, () => ({ expired: false })) },
          '<https://api.github.com/page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          artifacts: [
            { name: "campus-claude-invocation-abc", expired: false },
          ],
        }),
      );
    const adapter = new GitHubRestAdapter({
      apiUrl: "https://api.github.com",
      token: "token",
      fetcher,
    });

    await expect(
      adapter.hasInvocationClaim(
        "rise/campus-web",
        "campus-claude-invocation-abc",
      ),
    ).resolves.toBe(true);
  });
});

function jsonResponse(value: unknown, link?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(link === undefined ? {} : { link }),
    },
  });
}
