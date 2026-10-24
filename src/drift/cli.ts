import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compareRulesetSnapshots } from "./index.js";
import { parseRulesetSnapshot } from "./schema.js";

const expectedPath = process.argv[2];
const actualPath = process.argv[3];
if (expectedPath === undefined || actualPath === undefined) {
  process.stderr.write(
    "Usage: pnpm drift:check <expected-rulesets.json> <actual-rulesets.json>\n",
  );
  process.exitCode = 1;
} else {
  try {
    const [expected, actual] = await Promise.all([
      readSnapshot(expectedPath),
      readSnapshot(actualPath),
    ]);
    const findings = compareRulesetSnapshots(expected, actual);
    process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
    if (findings.length > 0) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

async function readSnapshot(path: string) {
  return parseRulesetSnapshot(await readFile(resolve(path), "utf8"));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
