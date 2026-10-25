import { checkRunName, type CheckRunReport } from "./check-run.ts";
import type { ChangedFile } from "./contracts.ts";
import type {
  FactoryCheckRun,
  GitHubReviewPort,
  PullRequest,
  WorkflowRun,
} from "./execution.ts";

const checkRunsAppSlug = "github-actions";

export interface SuccessfulPullRequestRun {
  headSha: string;
  headRepository: string;
  pullRequestNumbers: number[];
  completedAt: string;
}

interface GitHubRestAdapterOptions {
  apiUrl: string;
  token: string;
  fetcher?: typeof fetch;
}

export class GitHubRestAdapter implements GitHubReviewPort {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: GitHubRestAdapterOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  async getWorkflowRun(
    repository: string,
    workflowRunId: number,
  ): Promise<WorkflowRun> {
    const value = requireObject(
      await this.request(`/repos/${repository}/actions/runs/${workflowRunId}`),
      "workflow run",
    );
    const headRepository = requireObject(
      value.head_repository,
      "workflow head repository",
    );
    return {
      name: requireString(value.name, "workflow name"),
      conclusion:
        value.conclusion === null
          ? ""
          : requireString(value.conclusion, "workflow conclusion"),
      event: requireString(value.event, "workflow event"),
      headSha: requireString(value.head_sha, "workflow head SHA"),
      headRepository: requireString(
        headRepository.full_name,
        "workflow head repository name",
      ),
      pullRequestNumbers: requireArray(value.pull_requests, "workflow pull requests").map(
        (entry) =>
          requireNumber(
            requireObject(entry, "workflow pull request").number,
            "workflow pull request number",
          ),
      ),
    };
  }

  async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequest> {
    const value = requireObject(
      await this.request(`/repos/${repository}/pulls/${pullRequestNumber}`),
      "pull request",
    );
    const head = requireObject(value.head, "pull request head");
    const base = requireObject(value.base, "pull request base");
    const headRepository = requireObject(head.repo, "pull request head repository");
    return {
      number: requireNumber(value.number, "pull request number"),
      state: requireString(value.state, "pull request state"),
      draft: requireBoolean(value.draft, "pull request draft state"),
      baseRef: requireString(base.ref, "pull request base ref"),
      baseSha: requireString(base.sha, "pull request base SHA"),
      headSha: requireString(head.sha, "pull request head SHA"),
      headRepository: requireString(
        headRepository.full_name,
        "pull request head repository name",
      ),
      body: value.body === null ? "" : requireString(value.body, "pull request body", true),
    };
  }

  async listPullRequestFiles(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ChangedFile[]> {
    const pages = await this.paginate(
      `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100`,
    );
    return pages.flatMap((page) =>
      requireArray(page, "pull request file page").map((value) => {
        const file = requireObject(value, "pull request file");
        return {
          path: requireString(file.filename, "pull request file name"),
          patch: typeof file.patch === "string" ? file.patch : null,
        };
      }),
    );
  }

  async listFactoryCheckRuns(
    repository: string,
    headSha: string,
  ): Promise<FactoryCheckRun[]> {
    const pages = await this.paginate(
      `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(checkRunName)}&filter=all&per_page=100`,
    );
    return pages.flatMap((page) =>
      requireArray(requireObject(page, "check run page").check_runs, "check runs").flatMap(
        (value) => {
          const checkRun = requireObject(value, "check run");
          const app = requireObject(checkRun.app, "check run app");
          if (app.slug !== checkRunsAppSlug) {
            return [];
          }
          return [
            {
              id: requireNumber(checkRun.id, "check run id"),
              status: requireCheckStatus(checkRun.status),
              externalId:
                typeof checkRun.external_id === "string" ? checkRun.external_id : null,
              completedAt:
                typeof checkRun.completed_at === "string" ? checkRun.completed_at : null,
            },
          ];
        },
      ),
    );
  }

  async listSuccessfulPullRequestRuns(
    repository: string,
    workflowName: string,
    since: string,
  ): Promise<SuccessfulPullRequestRun[]> {
    const pages = await this.paginate(
      `/repos/${repository}/actions/runs?event=pull_request&status=success&created=${encodeURIComponent(`>=${since}`)}&per_page=100`,
    );
    const runs = pages.flatMap((page) =>
      requireArray(requireObject(page, "workflow run page").workflow_runs, "workflow runs")
        .map((value) => requireObject(value, "workflow run"))
        .filter((run) => run.name === workflowName),
    );
    return Promise.all(
      runs.map(async (run) => ({
        headSha: requireString(run.head_sha, "workflow head SHA"),
        headRepository: requireString(
          requireObject(run.head_repository, "workflow head repository").full_name,
          "workflow head repository name",
        ),
        pullRequestNumbers: requireArray(run.pull_requests, "workflow pull requests").map(
          (entry) =>
            requireNumber(
              requireObject(entry, "workflow pull request").number,
              "workflow pull request number",
            ),
        ),
        completedAt: await this.firstSuccessfulAttemptCompletedAt(repository, run),
      })),
    );
  }

  // A listed run shows its latest attempt, and a rerun moves its updated_at.
  // The review was triggered by the first attempt that succeeded.
  private async firstSuccessfulAttemptCompletedAt(
    repository: string,
    run: Record<string, unknown>,
  ): Promise<string> {
    const latestAttempt = requireNumber(run.run_attempt, "workflow run attempt");
    const runId = requireNumber(run.id, "workflow run ID");
    for (let attempt = 1; attempt < latestAttempt; attempt += 1) {
      const earlier = requireObject(
        await this.request(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`),
        "workflow run attempt",
      );
      if (earlier.conclusion === "success") {
        return requireString(earlier.updated_at, "workflow attempt completion time");
      }
    }
    return requireString(run.updated_at, "workflow completion time");
  }

  async listPullRequestLabels(
    repository: string,
    pullRequestNumber: number,
  ): Promise<string[]> {
    const pages = await this.paginate(
      `/repos/${repository}/issues/${pullRequestNumber}/labels?per_page=100`,
    );
    return pages.flatMap((page) =>
      requireArray(page, "label page").map((value) =>
        requireString(requireObject(value, "label").name, "label name"),
      ),
    );
  }

  async startCheckRun(
    repository: string,
    headSha: string,
    externalId: string,
  ): Promise<number> {
    const created = requireObject(
      await this.request(`/repos/${repository}/check-runs`, {
        method: "POST",
        body: JSON.stringify({
          name: checkRunName,
          head_sha: headSha,
          status: "in_progress",
          external_id: externalId,
          output: {
            title: "Review in progress",
            summary: "The factory reviewer is checking this head SHA.",
          },
        }),
      }),
      "created check run",
    );
    return requireNumber(created.id, "created check run id");
  }

  async publishCheckRun(
    repository: string,
    headSha: string,
    report: CheckRunReport,
  ): Promise<void> {
    await this.request(`/repos/${repository}/check-runs`, {
      method: "POST",
      body: JSON.stringify({ name: report.name, head_sha: headSha, ...completedBody(report) }),
    });
  }

  async completeCheckRun(
    repository: string,
    checkRunId: number,
    report: CheckRunReport,
  ): Promise<void> {
    await this.request(`/repos/${repository}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify(completedBody(report)),
    });
  }

  private async paginate(path: string): Promise<unknown[]> {
    const pages: unknown[] = [];
    let nextUrl: string | null = `${this.apiUrl}${path}`;
    while (nextUrl !== null) {
      const response = await this.fetch(nextUrl);
      pages.push(await readJson(response));
      nextUrl = nextLink(response.headers.get("link"));
    }
    return pages;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return readJson(await this.fetch(`${this.apiUrl}${path}`, init));
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Content-Type", "application/json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const response = await this.fetcher(url, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} ${response.statusText} for ${url}`,
      );
    }
    return response;
  }
}

function completedBody(report: CheckRunReport) {
  return {
    status: "completed",
    conclusion: report.conclusion,
    external_id: report.externalId,
    output: {
      title: report.title,
      summary: report.summary,
      annotations: report.annotations.map((annotation) => ({
        path: annotation.path,
        start_line: annotation.startLine,
        end_line: annotation.endLine,
        annotation_level: annotation.annotationLevel,
        title: annotation.title,
        message: annotation.message,
      })),
    },
  };
}

// GitHub also reports waiting, requested, and pending; only completion matters here.
function requireCheckStatus(value: unknown): FactoryCheckRun["status"] {
  const status = requireString(value, "check run status");
  if (status === "completed" || status === "queued") {
    return status;
  }
  return "in_progress";
}

function nextLink(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  return response.status === 204 ? null : (response.json() as Promise<unknown>);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}
