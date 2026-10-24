import { access, readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

interface WorkflowContract {
  fileName: string;
  requiredFragments: readonly string[];
}

const FORBIDDEN_COMMANDS = [
  "test:ci",
  "test:integration",
  "contract:check",
  "migration:dry-run",
] as const;

const WORKFLOW_CONTRACTS: readonly WorkflowContract[] = [
  {
    fileName: "web-ci.yml",
    requiredFragments: [
      "workflow_call:",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm format:check",
      "pnpm test",
      "pnpm eval:storybook",
      "pnpm build",
      "pnpm exec playwright test --project=chromium",
      "STAGING_NEXT_PUBLIC_SANITY_DATASET",
      "PRODUCTION_NEXT_PUBLIC_SANITY_DATASET",
    ],
  },
  {
    fileName: "server-ci.yml",
    requiredFragments: [
      "workflow_call:",
      "redis:",
      "postgres:",
      "pnpm lint",
      "pnpm format:check",
      "pnpm build",
      "pnpm test",
      "curl -sf http://localhost:3000/v1/health",
      "pnpm --filter campus-api test:e2e",
    ],
  },
  {
    fileName: "mobile-ci.yml",
    requiredFragments: [
      "workflow_call:",
      "fetch-depth: 0",
      "pnpm commitlint",
      "github.event.pull_request.base.sha",
      "github.event.pull_request.head.sha",
      "pnpm check",
    ],
  },
] as const;

async function loadWorkflow(fileName: string): Promise<string> {
  return readFile(
    new URL(`../../.github/workflows/${fileName}`, import.meta.url),
    "utf8",
  );
}

async function loadCallerTemplate(): Promise<string> {
  return readFile(
    new URL("../../templates/factory-caller.yml", import.meta.url),
    "utf8",
  );
}

describe.each(WORKFLOW_CONTRACTS)("$fileName", (contract) => {
  test("preserves audited product gates", async () => {
    const source = await loadWorkflow(contract.fileName);

    for (const fragment of contract.requiredFragments) {
      expect(source, `Missing workflow contract: ${fragment}`).toContain(
        fragment,
      );
    }

    for (const command of FORBIDDEN_COMMANDS) {
      expect(source, `Unsupported product command: ${command}`).not.toContain(
        command,
      );
    }
  });

  test("pins every external action to a commit SHA", async () => {
    const source = await loadWorkflow(contract.fileName);
    const externalActions = Array.from(
      source.matchAll(
        /^\s*uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/gm,
      ),
      ([, action, reference]) => ({ action, reference }),
    );

    expect(externalActions).not.toHaveLength(0);

    for (const { action, reference } of externalActions) {
      expect(reference, `${action} must use a commit SHA`).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
  });
});

describe("workflow public surface", () => {
  test("does not expose the obsolete generic Node workflow", async () => {
    await expect(
      access(
        new URL(
          "../../.github/workflows/_node-quality.yml",
          import.meta.url,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("ships a SHA-pinned caller with a stable aggregate gate", async () => {
    const source = await loadCallerTemplate();
    const requiredFragments = [
      "branches: [dev, main]",
      "factory:",
      "uses: Risevestacademy/campus-software-factory/.github/workflows/PROFILE-ci.yml@PINNED_40_CHARACTER_COMMIT_SHA",
      "quality-gate:",
      "needs: factory",
      "if: always() && github.event.pull_request.draft == false",
      "FACTORY_RESULT: ${{ needs.factory.result }}",
      'test "$FACTORY_RESULT" = "success"',
    ];

    for (const fragment of requiredFragments) {
      expect(source, `Missing caller contract: ${fragment}`).toContain(
        fragment,
      );
    }

    expect(source).not.toContain("secrets: inherit");
    expect(source).not.toContain("with:");
  });
});
