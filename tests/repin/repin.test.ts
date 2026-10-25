import { describe, expect, test } from "vitest";

import type { RepositoryPolicy } from "../../src/policy/index.js";
import {
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
  test("creates a branch, updates the caller, and opens a PR into dev", async () => {
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
        path: ".github/workflows/factory-pr-review.yml",
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
        body: expect.stringContaining("## Change and measurable outcome") as string,
      }),
    ]);
  });

  test.each([
    [
      "the repin branch already exists",
      { branchExists: true },
      `Branch "chore/repin-factory-review" already exists`,
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

function createGitHub(options: { branchExists?: boolean; workflow?: string } = {}) {
  const createdBranches: Array<Record<string, string>> = [];
  const updatedFiles: UpdateRepositoryFileInput[] = [];
  const pullRequests: OpenPullRequestInput[] = [];
  const port: RepinGitHubPort = {
    getFactoryMainSha: async () => factorySha,
    branchExists: async () => options.branchExists ?? false,
    getBranchSha: async () => "c".repeat(40),
    getFile: async () => ({
      content: options.workflow ?? workflow,
      sha: "workflow-blob",
    }),
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
