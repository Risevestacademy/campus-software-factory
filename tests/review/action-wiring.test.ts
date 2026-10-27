import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

interface ActionStep {
  id?: string;
  "continue-on-error"?: boolean;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

const source = await readFile(
  new URL("../../.github/actions/factory-pr-review/action.yml", import.meta.url),
  "utf8",
);
const steps = (parse(source) as { runs: { steps: ActionStep[] } }).runs.steps;

const providerSteps = [
  "claude_1",
  "codex_1",
  "claude_2",
  "codex_2",
  "codex_3",
  "codex_4",
];
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
  test("runs preflight, four routed attempt slots, publish, then the failure guard", () => {
    const order = [
      "preflight",
      "checkout_pr",
      "checkout_trusted",
      "bubblewrap",
      "claude_1",
      "codex_1",
      "keep_1",
      "validate_1",
      "route_1",
      "claude_2",
      "codex_2",
      "keep_2",
      "validate_2",
      "route_2",
      "codex_3",
      "keep_3",
      "validate_3",
      "route_3",
      "codex_4",
      "keep_4",
      "validate_4",
      "route_4",
      "publish",
      "fail",
    ].map(indexOf);

    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("isolates each provider's credential and sandbox", () => {
    for (const id of ["claude_1", "claude_2"]) {
      expect(text(step(id))).toContain(claudeSecret);
      expect(text(step(id))).not.toContain(codexSecret);
      expect(step(id).env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
      expect(step(id).with?.github_token).toBe("${{ inputs.github-token }}");
    }
    for (const id of ["codex_1", "codex_2", "codex_3", "codex_4"]) {
      expect(text(step(id))).toContain(codexSecret);
      expect(text(step(id))).not.toContain(claudeSecret);
      expect(step(id).with?.["permission-profile"]).toBe(":read-only");
      expect(step(id).with?.["safety-strategy"]).toBe("drop-sudo");
    }
    for (const other of steps.filter((entry) => !providerSteps.includes(entry.id ?? ""))) {
      expect(text(other)).not.toContain(claudeSecret);
      expect(text(other)).not.toContain(codexSecret);
    }
  });

  test("installs bubblewrap exactly when Claude would run, and stops the review if it cannot", () => {
    expect(step("bubblewrap").if).toBe(step("claude_1").if);
    expect(step("bubblewrap")["continue-on-error"]).toBeUndefined();
  });

  test("runs each later slot with the provider and effort the previous router chose", () => {
    expect(step("claude_1").if).toContain("steps.preflight.outputs.provider == 'claude'");
    expect(step("codex_1").if).toContain("steps.preflight.outputs.provider == 'codex'");
    expect(step("codex_1").with?.effort).toBe("${{ steps.preflight.outputs.effort }}");
    for (const [id, route] of [
      ["claude_2", "route_1"],
      ["codex_2", "route_1"],
      ["codex_3", "route_2"],
      ["codex_4", "route_3"],
    ] as const) {
      const provider = id.startsWith("claude") ? "claude" : "codex";
      expect(step(id).if).toContain(`steps.${route}.outputs.run_next == 'true'`);
      expect(step(id).if).toContain(`steps.${route}.outputs.next_provider == '${provider}'`);
      if (provider === "codex") {
        expect(step(id).with?.effort).toBe(`\${{ steps.${route}.outputs.next_effort }}`);
      }
    }
  });

  test("keeps each slot's own provider output and publishes from one shared file", () => {
    for (const attempt of ["1", "2", "3", "4"]) {
      expect(step(`keep_${attempt}`).env?.CODEX_FILE).toBe(
        step(`codex_${attempt}`).with?.["output-file"],
      );
    }
    expect(step("keep_1").env?.CLAUDE_FILE).toBe("${{ steps.claude_1.outputs.execution_file }}");
    expect(step("keep_2").env?.CLAUDE_FILE).toBe("${{ steps.claude_2.outputs.execution_file }}");

    const codexFiles = ["1", "2", "3", "4"].map((attempt) => step(`codex_${attempt}`).with?.["output-file"]);
    expect(new Set(codexFiles).size).toBe(4);

    const sharedFiles = [
      ...["1", "2", "3", "4"].flatMap((attempt) => [
        step(`keep_${attempt}`).env?.REVIEW_OUTPUT_FILE,
        step(`validate_${attempt}`).env?.REVIEW_OUTPUT_FILE,
      ]),
      step("publish").env?.REVIEW_OUTPUT_FILE,
    ];
    expect(new Set(sharedFiles).size).toBe(1);
    expect(sharedFiles[0]).toBeDefined();
  });

  test("never passes model output through an environment variable or input", () => {
    for (const entry of steps) {
      expect(text(entry), entry.id).not.toContain("structured_output");
      expect(text(entry), entry.id).not.toContain("final-message");
    }
  });

  test("never persists checkout credentials and reads guidance from the base SHA", () => {
    for (const checkout of steps.filter((entry) => entry.uses?.startsWith("actions/checkout@"))) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
    expect(step("checkout_pr").with?.ref).toBe("${{ steps.preflight.outputs.head_sha }}");
    expect(step("checkout_trusted").with?.ref).toBe("${{ steps.preflight.outputs.base_sha }}");
  });

  test("completes a pending check as technical on any later failure or cancellation", () => {
    expect(step("fail").if).toContain("always()");
    expect(step("fail").if).toContain("steps.publish.outcome != 'success'");
  });
});
