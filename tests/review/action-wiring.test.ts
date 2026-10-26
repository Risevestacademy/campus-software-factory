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

  test("hands each provider step only its own credential", () => {
    for (const id of ["claude_1", "claude_2"]) {
      expect(text(step(id))).toContain(claudeSecret);
      expect(text(step(id))).not.toContain(codexSecret);
    }
    for (const id of ["codex_1", "codex_2", "codex_3", "codex_4"]) {
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

  test("installs bubblewrap exactly when Claude would run, and stops the review if it cannot", () => {
    expect(step("bubblewrap").if).toBe(step("claude_1").if);
    expect(step("bubblewrap").run).toBe('bash "$GITHUB_ACTION_PATH/install-bubblewrap.sh"');
    expect(step("bubblewrap")["continue-on-error"]).toBeUndefined();
  });

  test("gates every later provider slot on the router output", () => {
    expect(step("claude_1").if).toContain("steps.preflight.outputs.provider == 'claude'");
    expect(step("codex_1").if).toContain("steps.preflight.outputs.provider == 'codex'");
    for (const id of ["claude_2", "codex_2"]) {
      expect(step(id).if).toContain("steps.route_1.outputs.run_next == 'true'");
      expect(step(id).if).toContain(
        `steps.route_1.outputs.next_provider == '${id.startsWith("claude") ? "claude" : "codex"}'`,
      );
    }
    for (const [id, route] of [
      ["codex_3", "route_2"],
      ["codex_4", "route_3"],
    ] as const) {
      expect(step(id).if).toContain(`steps.${route}.outputs.run_next == 'true'`);
      expect(step(id).if).toContain(`steps.${route}.outputs.next_provider == 'codex'`);
    }
  });

  test("passes the turn budget to every Claude attempt", () => {
    expect(step("claude_1").with?.claude_args).toContain(
      "--max-turns ${{ steps.preflight.outputs.max_turns }}",
    );
    expect(step("claude_2").with?.claude_args).toContain(
      "--max-turns ${{ steps.preflight.outputs.max_turns }}",
    );
  });

  test("never passes model output through an environment variable or input", () => {
    for (const entry of steps) {
      expect(text(entry), entry.id).not.toContain("structured_output");
      expect(text(entry), entry.id).not.toContain("final-message");
    }
  });

  test("pins Codex effort and gives every slot its own provider output file", () => {
    for (const attempt of ["1", "2", "3", "4"]) {
      expect(step(`codex_${attempt}`).with?.["output-file"]).toBe(
        `\${{ runner.temp }}/factory-codex-output-${attempt}.txt`,
      );
      expect(step(`keep_${attempt}`).env?.CODEX_FILE).toBe(
        step(`codex_${attempt}`).with?.["output-file"],
      );
    }
    expect(step("codex_1").with?.effort).toBe("${{ steps.preflight.outputs.effort }}");
    expect(step("codex_2").with?.effort).toBe("${{ steps.route_1.outputs.next_effort }}");
    expect(step("codex_3").with?.effort).toBe("${{ steps.route_2.outputs.next_effort }}");
    expect(step("codex_4").with?.effort).toBe("${{ steps.route_3.outputs.next_effort }}");
  });

  test("keeps every attempted slot in one shared output file", () => {
    for (const attempt of ["1", "2", "3", "4"]) {
      const keep = step(`keep_${attempt}`);
      expect(keep.run).toBe('bash "$GITHUB_ACTION_PATH/keep-output.sh"');
      expect(keep.env?.REVIEW_OUTPUT_FILE).toBe(
        "${{ runner.temp }}/factory-review-output",
      );
    }
    expect(step("keep_1").env?.CLAUDE_FILE).toBe(
      "${{ steps.claude_1.outputs.execution_file }}",
    );
    expect(step("keep_2").env?.CLAUDE_FILE).toBe(
      "${{ steps.claude_2.outputs.execution_file }}",
    );
    expect(step("keep_3").env?.CLAUDE_FILE).toBe("");
    expect(step("keep_4").env?.CLAUDE_FILE).toBe("");
  });

  test("validates and routes every slot before publishing its attribution", () => {
    for (const attempt of ["1", "2", "3", "4"]) {
      expect(step(`validate_${attempt}`).env?.REVIEW_OUTPUT_FILE).toBe(
        "${{ runner.temp }}/factory-review-output",
      );
      expect(step(`validate_${attempt}`).run).toContain("action-runner.ts validate");
      expect(step(`route_${attempt}`).run).toContain("action-runner.ts route");
    }
    expect(step("publish").env?.REVIEW_OUTPUT_FILE).toBe(
      "${{ runner.temp }}/factory-review-output",
    );
    expect(step("publish").env?.ATTRIBUTION).toContain(
      "steps.route_4.outputs.attribution",
    );
    expect(step("publish").env?.ATTRIBUTION).toContain(
      "steps.route_1.outputs.attribution",
    );
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
    for (const id of ["codex_1", "codex_2", "codex_3", "codex_4"]) {
      expect(step(id).with?.["permission-profile"]).toBe(":read-only");
      expect(step(id).with?.["safety-strategy"]).toBe("drop-sudo");
    }
  });
});
