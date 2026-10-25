import { describe, expect, test } from "vitest";

import type { RepositoryPolicy } from "../../src/policy/index.js";
import {
  callerWorkflowPath,
  pullRequestTemplatePath,
  repinRepository,
  replaceFactoryPin,
  type OpenPullRequestInput,
  type RepinGitHubPort,
  type UpdateRepositoryFileInput,
} from "../../src/repin/repin.js";

const oldSha = "a".repeat(40);
const factorySha = "b".repeat(40);
const workflow = `name: Factory PR Review
jobs:
  review:
    uses: Risevestacademy/campus-software-factory/.github/actions/factory-pr-review@${oldSha}
`;
const pullRequestTemplate = `## Summary

<!-- Summary -->

## Change and measurable outcome

<!-- Outcome -->

## Changes

-

## Type of Change

- [ ] Feature
- [ ] Chore / Maintenance

## Repository-specific checks

- [ ] Keep this repository-specific control
`;
const repository: RepositoryPolicy = {
  id: "campus-web",
  github: "Risevestacademy/campus-web",
  ownerTeam: "Risevestacademy/campus",
  workflow: "web",
};

describe("replaceFactoryPin", () => {
  test("changes exactly the factory action SHA", () => {
    expect(replaceFactoryPin(workflow, factorySha)).toEqual({
      changed: true,
      previousSha: oldSha,
      content: workflow.replace(oldSha, factorySha),
    });
  });

  test("rejects a workflow without a factory pin", () => {
    expect(() => replaceFactoryPin("name: CI\n", factorySha)).toThrow(
      "Caller workflow must contain exactly one Factory PR Review pin; found 0",
    );
  });

  test("returns an unchanged result when the pin is already current", () => {
    const current = workflow.replace(oldSha, factorySha);

    expect(replaceFactoryPin(current, factorySha)).toEqual({
      changed: false,
      previousSha: factorySha,
      content: current,
    });
  });
});

describe("repinRepository", () => {
  test("creates a repin PR from the target repository template", async () => {
    const fake = createGitHub();

    await expect(repinRepository(repository, fake.port)).resolves.toEqual({
      factorySha,
      pullRequestUrl: "https://github.com/Risevestacademy/campus-web/pull/67",
    });
    expect(fake.createdBranches).toEqual([
      {
        repository: repository.github,
        branch: "chore/repin-factory-review",
        sha: "c".repeat(40),
      },
    ]);
    expect(fake.updatedFiles).toEqual([
      expect.objectContaining({
        repository: repository.github,
        path: callerWorkflowPath,
        branch: "chore/repin-factory-review",
        fileSha: "workflow-blob",
        content: workflow.replace(oldSha, factorySha),
      }),
    ]);
    expect(fake.pullRequests).toEqual([
      expect.objectContaining({
        repository: repository.github,
        head: "chore/repin-factory-review",
        base: "dev",
      }),
    ]);
    const body = fake.pullRequests[0]?.body;
    expect(body?.match(/^## .+$/gm)).toEqual([
      "## Summary",
      "## Change and measurable outcome",
      "## Changes",
      "## Type of Change",
      "## Repository-specific checks",
    ]);
    expect(body).toContain(
      "New campus-web CI runs use the current factory review policy and action.",
    );
    expect(body).toContain("- [x] Chore / Maintenance");
    expect(body).toContain("- [ ] Keep this repository-specific control");
  });

  test.each([
    [
      "the repin branch already exists",
      { branchExists: true },
      `Branch "chore/repin-factory-review" already exists`,
    ],
    [
      "the target PR template cannot be loaded",
      { pullRequestTemplateError: new Error("template unavailable") },
      "template unavailable",
    ],
    [
      "the caller has no factory pin",
      { workflow: "name: CI\n" },
      "found 0",
    ],
    [
      "the pin is already current",
      { workflow: workflow.replace(oldSha, factorySha) },
      `already pins Factory PR Review to ${factorySha}`,
    ],
  ])("fails before mutation when %s", async (_label, options, message) => {
    const fake = createGitHub(options);

    await expect(repinRepository(repository, fake.port)).rejects.toThrow(message);
    expect(fake.createdBranches).toEqual([]);
    expect(fake.updatedFiles).toEqual([]);
    expect(fake.pullRequests).toEqual([]);
  });
});

interface GitHubOptions {
  branchExists?: boolean;
  workflow?: string;
  pullRequestTemplate?: string;
  pullRequestTemplateError?: Error;
}

function createGitHub(options: GitHubOptions = {}) {
  const createdBranches: Array<Record<string, string>> = [];
  const updatedFiles: UpdateRepositoryFileInput[] = [];
  const pullRequests: OpenPullRequestInput[] = [];
  const port: RepinGitHubPort = {
    getFactoryMainSha: async () => factorySha,
    branchExists: async () => options.branchExists ?? false,
    getBranchSha: async () => "c".repeat(40),
    getFile: async (_repository, path) => {
      if (path === callerWorkflowPath) {
        return {
          content: options.workflow ?? workflow,
          sha: "workflow-blob",
        };
      }
      if (path === pullRequestTemplatePath) {
        if (options.pullRequestTemplateError !== undefined) {
          throw options.pullRequestTemplateError;
        }
        return {
          content: options.pullRequestTemplate ?? pullRequestTemplate,
          sha: "template-blob",
        };
      }
      throw new Error(`Unexpected repository file path "${path}"`);
    },
    createBranch: async (githubRepository: string, branch: string, sha: string) => {
      createdBranches.push({ repository: githubRepository, branch, sha });
    },
    updateFile: async (input) => {
      updatedFiles.push(input);
    },
    openPullRequest: async (input) => {
      pullRequests.push(input);
      return "https://github.com/Risevestacademy/campus-web/pull/67";
    },
  };
  return { port, createdBranches, updatedFiles, pullRequests };
}
