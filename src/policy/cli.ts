import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parsePolicyDocuments } from "./index.js";

const repositoryRegistryPath = resolve(
  process.argv[2] ?? "policies/repo-registry.yaml",
);
const sensitivePathsPath = resolve(
  process.argv[3] ?? "policies/sensitive-paths.yaml",
);

try {
  const [repositoryRegistry, sensitivePaths] = await Promise.all([
    readFile(repositoryRegistryPath, "utf8"),
    readFile(sensitivePathsPath, "utf8"),
  ]);
  const policy = parsePolicyDocuments(repositoryRegistry, sensitivePaths);
  process.stdout.write(
    `${JSON.stringify(
      {
        repositories: policy.repositories.length,
        mechanicalRules: policy.paths.mechanicalAllowlist.length,
        sensitiveRules: policy.paths.sensitivePaths.length,
      },
      null,
      2,
    )}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
