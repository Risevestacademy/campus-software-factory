import { describe, expect, test, vi } from "vitest";

import {
  GhApiRepinGitHub,
  type GhApiRunner,
} from "../../src/repin/gh-api.js";

const repository = "Risevestacademy/campus-web";
const factoryRepository = "Risevestacademy/campus-software-factory";
const branch = "chore/repin-factory-review";
const workflowPath = ".github/workflows/factory-pr-review.yml";
const factorySha = "a".repeat(40);
const devSha = "b".repeat(40);
const workflow = "name: Factory PR Review\n";

describe("GhApiRepinGitHub", () => {
  test("maps repin operations to gh api paths and payloads", async () => {
    const runner = vi.fn<GhApiRunner>(async (args) => {
      const path = args[1];
      if (path === `repos/${factoryRepository}/commits/main`) {
        return `${factorySha}\n`;
      }
      if (path === `repos/${repository}/git/ref/heads/dev`) {
        return `${devSha}\n`;
      }
      if (path?.startsWith(`repos/${repository}/contents/`) && !args.includes("PUT")) {
        return JSON.stringify({
          content: Buffer.from(workflow).toString("base64"),
          sha: "workflow-blob",
        });
      }
      if (path === `repos/${repository}/pulls`) {
        return "https://github.com/Risevestacademy/campus-web/pull/67\n";
      }
      return "";
    });
    const github = new GhApiRepinGitHub(runner);

    await expect(github.getFactoryMainSha()).resolves.toBe(factorySha);
    await expect(github.branchExists(repository, branch)).resolves.toBe(true);
    await expect(github.getBranchSha(repository, "dev")).resolves.toBe(devSha);
    await expect(github.getFile(repository, workflowPath, "dev")).resolves.toEqual({
      content: workflow,
      sha: "workflow-blob",
    });
    await github.createBranch(repository, branch, devSha);
    await github.updateFile({
      repository,
      path: workflowPath,
      branch,
      fileSha: "workflow-blob",
      content: workflow,
      message: "chore: repin Factory PR Review",
    });
    await expect(
      github.openPullRequest({
        repository,
        title: "chore: repin Factory PR Review",
        body: "body",
        head: branch,
        base: "dev",
      }),
    ).resolves.toBe("https://github.com/Risevestacademy/campus-web/pull/67");

    expect(runner.mock.calls.map(([args]) => args)).toEqual([
      ["api", `repos/${factoryRepository}/commits/main`, "--jq", ".sha"],
      [
        "api",
        `repos/${repository}/git/ref/heads/chore%2Frepin-factory-review`,
        "--silent",
      ],
      ["api", `repos/${repository}/git/ref/heads/dev`, "--jq", ".object.sha"],
      ["api", `repos/${repository}/contents/${workflowPath}?ref=dev`],
      [
        "api",
        `repos/${repository}/git/refs`,
        "--method",
        "POST",
        "--raw-field",
        `ref=refs/heads/${branch}`,
        "--raw-field",
        `sha=${devSha}`,
        "--silent",
      ],
      [
        "api",
        `repos/${repository}/contents/${workflowPath}`,
        "--method",
        "PUT",
        "--raw-field",
        "message=chore: repin Factory PR Review",
        "--raw-field",
        `content=${Buffer.from(workflow).toString("base64")}`,
        "--raw-field",
        "sha=workflow-blob",
        "--raw-field",
        `branch=${branch}`,
        "--silent",
      ],
      [
        "api",
        `repos/${repository}/pulls`,
        "--method",
        "POST",
        "--raw-field",
        "title=chore: repin Factory PR Review",
        "--raw-field",
        "body=body",
        "--raw-field",
        `head=${branch}`,
        "--raw-field",
        "base=dev",
        "--jq",
        ".html_url",
      ],
    ]);
  });

  test("treats HTTP 404 as an absent repin branch", async () => {
    const runner = vi
      .fn<GhApiRunner>()
      .mockRejectedValue(new Error("gh api failed: HTTP 404"));

    await expect(
      new GhApiRepinGitHub(runner).branchExists(repository, branch),
    ).resolves.toBe(false);
  });
});
