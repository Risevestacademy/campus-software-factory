import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { providerCredentialSecrets } from "../../src/review/index.js";

const caller = parse(
  await readFile(new URL("../../templates/factory-review-caller.yml", import.meta.url), "utf8"),
) as { jobs: { review: { steps: { with?: Record<string, string> }[] } } };

describe("factory review caller template", () => {
  test("passes exactly the provider secrets the review policy accepts", () => {
    const inputs = caller.jobs.review.steps[0]?.with ?? {};

    expect(inputs["claude-code-oauth-token"]).toBe(
      `\${{ secrets.${providerCredentialSecrets.claude} }}`,
    );
    expect(inputs["openai-api-key"]).toBe(`\${{ secrets.${providerCredentialSecrets.codex} }}`);
  });
});
