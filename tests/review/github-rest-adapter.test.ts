import { describe, expect, test, vi } from "vitest";

import { GitHubRestAdapter } from "../../src/review/github-rest-adapter.js";
import type { CheckRunReport } from "../../src/review/index.js";

const report: CheckRunReport = {
  name: "Factory PR Review",
  conclusion: "failure",
  externalId: "factory-review:v1:findings:123",
  title: "1 blocking finding",
  summary: "summary",
  annotations: [
    {
      path: "src/session.ts",
      startLine: 42,
      endLine: 42,
      annotationLevel: "failure",
      title: "P1: Renewal drops presence",
      message: "message",
    },
  ],
};

function adapter(fetcher: typeof fetch): GitHubRestAdapter {
  return new GitHubRestAdapter({
    apiUrl: "https://api.github.com",
    token: "token",
    fetcher,
  });
}

describe("GitHubRestAdapter", () => {
  test("paginates changed files and keeps a missing patch as null", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            filename: `src/file-${index}.ts`,
            patch: "@@ -1 +1 @@\n-a\n+b",
          })),
          '<https://api.github.com/page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(jsonResponse([{ filename: "assets/logo.png" }]));

    const files = await adapter(fetcher).listPullRequestFiles("rise/campus-web", 21);

    expect(files).toHaveLength(101);
    expect(files.at(-1)).toEqual({ path: "assets/logo.png", patch: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("lists factory checks across pages and ignores other apps", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            check_runs: [
              {
                id: 1,
                status: "completed",
                external_id: "factory-review:v1:findings:100",
                completed_at: "2026-10-25T10:05:00Z",
                app: { slug: "github-actions" },
              },
              {
                id: 2,
                status: "completed",
                external_id: "factory-review:v1:clean:100",
                app: { slug: "impostor-app" },
              },
            ],
          },
          '<https://api.github.com/page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          check_runs: [
            {
              id: 3,
              status: "in_progress",
              external_id: null,
              completed_at: null,
              app: { slug: "github-actions" },
            },
          ],
        }),
      );

    await expect(
      adapter(fetcher).listFactoryCheckRuns("rise/campus-web", "abc"),
    ).resolves.toEqual([
      {
        id: 1,
        status: "completed",
        externalId: "factory-review:v1:findings:100",
        completedAt: "2026-10-25T10:05:00Z",
      },
      { id: 3, status: "in_progress", externalId: null, completedAt: null },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/rise/campus-web/commits/abc/check-runs?check_name=Factory%20PR%20Review&filter=all&per_page=100",
    );
  });

  test("starts an in-progress check and returns its id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ id: 77 }));

    await expect(
      adapter(fetcher).startCheckRun("rise/campus-web", "abc", "factory-review:v1:pending:123"),
    ).resolves.toBe(77);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      name: "Factory PR Review",
      head_sha: "abc",
      status: "in_progress",
      external_id: "factory-review:v1:pending:123",
      output: {
        title: "Review in progress",
        summary: "The factory reviewer is checking this head SHA.",
      },
    });
  });

  test("publishes a completed check with snake_case annotations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ id: 78 }));

    await adapter(fetcher).publishCheckRun("rise/campus-web", "abc", report);

    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      name: "Factory PR Review",
      head_sha: "abc",
      status: "completed",
      conclusion: "failure",
      external_id: "factory-review:v1:findings:123",
      output: {
        title: "1 blocking finding",
        summary: "summary",
        annotations: [
          {
            path: "src/session.ts",
            start_line: 42,
            end_line: 42,
            annotation_level: "failure",
            title: "P1: Renewal drops presence",
            message: "message",
          },
        ],
      },
    });
  });

  test("completes an existing check in place", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ id: 77 }));

    await adapter(fetcher).completeCheckRun("rise/campus-web", 77, report);

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/rise/campus-web/check-runs/77",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "failure",
      external_id: "factory-review:v1:findings:123",
    });
  });

  test("lists successful pull request CI runs for one workflow since the canary start", async () => {
    const run = (name: string, sha: string) => ({
      name,
      head_sha: sha,
      updated_at: "2026-10-25T10:00:00Z",
      head_repository: { full_name: "rise/campus-web" },
      pull_requests: [{ number: 21 }],
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { workflow_runs: [run("CI", "abc"), run("Railway plan", "abc")] },
          '<https://api.github.com/page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ workflow_runs: [run("CI", "def")] }));

    await expect(
      adapter(fetcher).listSuccessfulPullRequestRuns(
        "rise/campus-web",
        "CI",
        "2026-10-25T09:00:00Z",
      ),
    ).resolves.toEqual([
      {
        headSha: "abc",
        headRepository: "rise/campus-web",
        pullRequestNumbers: [21],
        completedAt: "2026-10-25T10:00:00Z",
      },
      {
        headSha: "def",
        headRepository: "rise/campus-web",
        pullRequestNumbers: [21],
        completedAt: "2026-10-25T10:00:00Z",
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/rise/campus-web/actions/runs?event=pull_request&status=success&created=%3E%3D2026-10-25T09%3A00%3A00Z&per_page=100",
    );
  });

  test("lists pull request label names", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([{ name: "factory-review:valid" }, { name: "frontend" }]),
      );

    await expect(
      adapter(fetcher).listPullRequestLabels("rise/campus-web", 21),
    ).resolves.toEqual(["factory-review:valid", "frontend"]);
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
