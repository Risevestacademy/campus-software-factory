import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  factoryRepository,
  type OpenPullRequestInput,
  type RepinGitHubPort,
  type RepositoryFile,
  type UpdateRepositoryFileInput,
} from "./repin.ts";

export type GhApiRunner = (args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export class GhApiRepinGitHub implements RepinGitHubPort {
  constructor(private readonly run: GhApiRunner = runGh) {}

  async getFactoryMainSha(): Promise<string> {
    return requireSha(
      await this.run([
        "api",
        `repos/${factoryRepository}/commits/main`,
        "--jq",
        ".sha",
      ]),
      "factory main SHA",
    );
  }

  async branchExists(repository: string, branch: string): Promise<boolean> {
    try {
      await this.run([
        "api",
        `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        "--silent",
      ]);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && /\bHTTP 404\b/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  async getBranchSha(repository: string, branch: string): Promise<string> {
    return requireSha(
      await this.run([
        "api",
        `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        "--jq",
        ".object.sha",
      ]),
      `${repository} ${branch} SHA`,
    );
  }

  async getFile(
    repository: string,
    path: string,
    ref: string,
  ): Promise<RepositoryFile> {
    const value = requireObject(
      await this.run([
        "api",
        `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      ]),
      "workflow file",
    );
    const content = requireString(value.content, "workflow file content");
    return {
      content: Buffer.from(content.replaceAll(/\s/g, ""), "base64").toString(
        "utf8",
      ),
      sha: requireString(value.sha, "workflow file SHA"),
    };
  }

  async createBranch(
    repository: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    await this.run([
      "api",
      `repos/${repository}/git/refs`,
      "--method",
      "POST",
      "--raw-field",
      `ref=refs/heads/${branch}`,
      "--raw-field",
      `sha=${sha}`,
      "--silent",
    ]);
  }

  async updateFile(input: UpdateRepositoryFileInput): Promise<void> {
    await this.run([
      "api",
      `repos/${input.repository}/contents/${input.path}`,
      "--method",
      "PUT",
      "--raw-field",
      `message=${input.message}`,
      "--raw-field",
      `content=${Buffer.from(input.content).toString("base64")}`,
      "--raw-field",
      `sha=${input.fileSha}`,
      "--raw-field",
      `branch=${input.branch}`,
      "--silent",
    ]);
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<string> {
    return requireString(
      await this.run([
        "api",
        `repos/${input.repository}/pulls`,
        "--method",
        "POST",
        "--raw-field",
        `title=${input.title}`,
        "--raw-field",
        `body=${input.body}`,
        "--raw-field",
        `head=${input.head}`,
        "--raw-field",
        `base=${input.base}`,
        "--jq",
        ".html_url",
      ]),
      "pull request URL",
    );
  }
}

async function runGh(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return String(stdout);
  } catch (error: unknown) {
    throw new Error(`gh api failed: ${commandError(error)}`, { cause: error });
  }
}

function requireObject(source: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${label} must be a full commit SHA`);
  }
  return sha;
}

function commandError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}
