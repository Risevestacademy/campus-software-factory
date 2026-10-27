import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  classifyChangedPaths,
  parsePolicyDocuments,
  type FactoryPolicyBundle,
  type RiskTier,
} from "../../src/policy/index.js";

async function loadPolicy(): Promise<FactoryPolicyBundle> {
  const [repositoryRegistry, sensitivePaths] = await Promise.all([
    readFile(
      new URL("../../policies/repo-registry.yaml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../policies/sensitive-paths.yaml", import.meta.url),
      "utf8",
    ),
  ]);

  return parsePolicyDocuments(repositoryRegistry, sensitivePaths);
}

describe("product adoption policy", () => {
  test("keeps audited product security and infrastructure paths sensitive", async () => {
    const policy = await loadPolicy();
    const cases: readonly [path: string, tier: RiskTier][] = [
      [".railway/railway.ts", "R3"],
      [".eas/workflows/build-staging.yaml", "R3"],
      ["proxy.ts", "R3"],
      ["core/realtime/realtime-client.ts", "R3"],
      ["apps/world/src/socket/gateway.ts", "R3"],
      ["src/core/api/generated/schema.d.ts", "R3"],
      ["app.config.ts", "R3"],
      ["apps/campus-api/src/infra/database/migrations/0021_roles.sql", "R4"],
    ];

    for (const [path, expectedTier] of cases) {
      expect(classifyChangedPaths([path], policy.paths), path).toBe(
        expectedTier,
      );
    }
  });
});
