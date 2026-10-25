import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

interface ActionStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

const source = await readFile(
  new URL("../../.github/actions/factory-pr-review/action.yml", import.meta.url),
  "utf8",
);
const steps = (parse(source) as { runs: { steps: ActionStep[] } }).runs.steps;

const providerSteps = ["claude_1", "codex_1", "claude_2", "codex_2"];
const claudeSecret = "inputs.claude-code-oauth-token";
const codexSecret = "inputs.openai-api-key";

function indexOf(id: string): number {
  const index = steps.findIndex((step) => step.id === id);
  expect(index, `missing step ${id}`).toBeGreaterThan(-1);
  return index;
}

function step(id: string): ActionStep {
  return steps[indexOf(id)] as ActionStep;
}

function text(value: ActionStep): string {
  return JSON.stringify(value);
}

describe("Factory PR Review composite action wiring", () => {
  test("runs preflight, checkouts, provider, validation, retry, publish, then the failure guard", () => {
    const order = [
      "preflight",
      "checkout_pr",
      "checkout_trusted",
      "claude_1",
      "codex_1",
      "validate_1",
      "claude_2",
      "codex_2",
      "publish",
      "fail",
    ].map(indexOf);

    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("hands each provider step only its own credential", () => {
    for (const id of ["claude_1", "claude_2"]) {
      expect(text(step(id))).toContain(claudeSecret);
      expect(text(step(id))).not.toContain(codexSecret);
    }
    for (const id of ["codex_1", "codex_2"]) {
      expect(text(step(id))).toContain(codexSecret);
      expect(text(step(id))).not.toContain(claudeSecret);
    }
    for (const other of steps.filter((entry) => !providerSteps.includes(entry.id ?? ""))) {
      expect(text(other)).not.toContain(claudeSecret);
      expect(text(other)).not.toContain(codexSecret);
    }
  });

  test("scrubs secrets from Claude subprocesses and hands it only the job token", () => {
    for (const id of ["claude_1", "claude_2"]) {
      expect(step(id).env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
      expect(step(id).with?.github_token).toBe("${{ inputs.github-token }}");
    }
  });

  test("gates each provider step on the policy-selected provider", () => {
    for (const id of ["claude_1", "claude_2"]) {
      expect(step(id).if).toContain("steps.preflight.outputs.provider == 'claude'");
    }
    for (const id of ["codex_1", "codex_2"]) {
      expect(step(id).if).toContain("steps.preflight.outputs.provider == 'codex'");
    }
  });

  test("retries only after invalid first output", () => {
    for (const id of ["claude_2", "codex_2"]) {
      expect(step(id).if).toContain("steps.validate_1.outputs.valid != 'true'");
    }
  });

  test("completes a pending check as technical on any later failure or cancellation", () => {
    expect(step("fail").if).toContain("always()");
    expect(step("fail").if).toContain("steps.publish.outcome != 'success'");
  });

  test("pins every external action to a full commit SHA", () => {
    const external = steps.flatMap((entry) => (entry.uses === undefined ? [] : [entry.uses]));

    expect(external.length).toBeGreaterThan(0);
    for (const uses of external) {
      expect(uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test("never persists checkout credentials and reads guidance from the base SHA", () => {
    for (const checkout of steps.filter((entry) => entry.uses?.startsWith("actions/checkout@"))) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
    expect(step("checkout_pr").with?.ref).toBe("${{ steps.preflight.outputs.head_sha }}");
    expect(step("checkout_trusted").with?.ref).toBe("${{ steps.preflight.outputs.base_sha }}");
  });

  test("runs Codex read-only without sudo", () => {
    for (const id of ["codex_1", "codex_2"]) {
      expect(step(id).with?.["permission-profile"]).toBe(":read-only");
      expect(step(id).with?.["safety-strategy"]).toBe("drop-sudo");
    }
  });
});
