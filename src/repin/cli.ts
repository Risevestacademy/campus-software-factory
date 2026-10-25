import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { validateRepositoryRegistry } from "../policy/schema.ts";
import { GhApiRepinGitHub } from "./gh-api.ts";
import { repinRepository } from "./repin.ts";

try {
  const repositoryId = process.argv[2];
  if (repositoryId === undefined) {
    throw new Error("Usage: pnpm repin <repository-id>");
  }
  const source = await readFile(
    new URL("../../policies/repo-registry.yaml", import.meta.url),
    "utf8",
  );
  const registry = validateRepositoryRegistry(parseYaml(source) as unknown);
  const repository = registry.repositories.find(
    (entry) => entry.id === repositoryId,
  );
  if (repository === undefined) {
    throw new Error(`Unknown repository id "${repositoryId}"`);
  }
  const result = await repinRepository(repository, new GhApiRepinGitHub());
  process.stdout.write(
    `Opened ${result.pullRequestUrl} for factory ${result.factorySha}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
