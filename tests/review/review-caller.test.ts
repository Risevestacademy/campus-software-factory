import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { providerCredentialSecrets } from "../../src/review/index.js";

interface Workflow {
  on: Record<string, { workflows?: string[]; types?: string[] }>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      "timeout-minutes"?: number;
      steps: Array<{ uses?: string; run?: string; with?: Record<string, string> }>;
    }
  >;
}

async function loadTemplate(name: string): Promise<Workflow> {
  return parse(
    await readFile(new URL(`../../templates/${name}`, import.meta.url), "utf8"),
  ) as Workflow;
}

const caller = await loadTemplate("factory-review-caller.yml");
const review = caller.jobs.review;

describe("factory review caller template", () => {
  test("runs only when product CI completes", () => {
    expect(caller.on).toEqual({
      workflow_run: { workflows: ["AUDITED_CI_WORKFLOW_NAME"], types: ["completed"] },
    });
  });

  test("grants exactly the review token scopes", () => {
    expect(caller.permissions).toEqual({
      actions: "read",
      contents: "read",
      checks: "write",
      "pull-requests": "read",
    });
  });

  test("serializes reviews of one head SHA without cancelling", () => {
    expect(caller.concurrency).toEqual({
      group: "factory-pr-review-${{ github.event.workflow_run.head_sha }}",
      "cancel-in-progress": false,
    });
  });

  test("skips failed or non-PR CI before a runner spends a credential", () => {
    expect(review?.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(review?.if).toContain("github.event.workflow_run.event == 'pull_request'");
  });

  test("allows enough time for two attempts from both providers", () => {
    expect(review?.["timeout-minutes"]).toBe(30);
  });

  test("calls the pinned factory action and never runs pull request code itself", () => {
    expect(review?.steps).toHaveLength(1);
    expect(review?.steps[0]?.uses).toBe(
      "Risevestacademy/campus-software-factory/.github/actions/factory-pr-review@PINNED_40_CHARACTER_COMMIT_SHA",
    );
    expect(review?.steps[0]?.run).toBeUndefined();
  });

  test("passes exactly the provider secrets the review policy accepts", () => {
    const inputs = review?.steps[0]?.with ?? {};

    expect(inputs["claude-code-oauth-token"]).toBe(
      `\${{ secrets.${providerCredentialSecrets.claude} }}`,
    );
    expect(inputs["openai-api-key"]).toBe(`\${{ secrets.${providerCredentialSecrets.codex} }}`);
  });

  test("keeps ready_for_review on product CI so drafts get reviewed when marked ready", async () => {
    const ci = await loadTemplate("factory-caller.yml");

    expect(ci.on.pull_request?.types).toContain("ready_for_review");
  });
});
