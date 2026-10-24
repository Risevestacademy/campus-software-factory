import type {
  GitHubReviewPort,
  PullRequest,
  WorkflowRun,
} from "./index.ts";

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
      baseSha: requireString(base.sha, "pull request base SHA"),
      headSha: requireString(head.sha, "pull request head SHA"),
      headRepository: requireString(
        headRepository.full_name,
        "pull request head repository name",
      ),
      body: value.body === null ? "" : requireString(value.body, "pull request body", true),
    };
  }

  async hasInvocationClaim(
    repository: string,
    claimName: string,
  ): Promise<boolean> {
    const pages = await this.paginate(
      `/repos/${repository}/actions/artifacts?name=${encodeURIComponent(claimName)}&per_page=100`,
    );
    return pages.some((page) => {
      const artifacts = requireArray(
        requireObject(page, "artifact page").artifacts,
        "artifacts",
      );
      return artifacts.some((value) => {
        const artifact = requireObject(value, "artifact");
        return artifact.name === claimName && artifact.expired === false;
      });
    });
  }

  async listReviewBodies(
    repository: string,
    pullRequestNumber: number,
  ): Promise<string[]> {
    const pages = await this.paginate(
      `/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100`,
    );
    return pages.flatMap((page) =>
      requireArray(page, "review page").flatMap((value) => {
        const body = requireObject(value, "review").body;
        return typeof body === "string" ? [body] : [];
      }),
    );
  }

  async publishCommentReview(
    repository: string,
    pullRequestNumber: number,
    body: string,
  ): Promise<void> {
    await this.request(`/repos/${repository}/pulls/${pullRequestNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ body, event: "COMMENT" }),
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
