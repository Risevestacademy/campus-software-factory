import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildMetricsReport } from "./index.js";
import { parseMetricsInput } from "./schema.js";

const inputPath = process.argv[2];
if (inputPath === undefined) {
  process.stderr.write("Usage: pnpm metrics:report <metrics-input.json>\n");
  process.exitCode = 1;
} else {
  try {
    const source = await readFile(resolve(inputPath), "utf8");
    const input = parseMetricsInput(source);
    process.stdout.write(`${JSON.stringify(buildMetricsReport(input), null, 2)}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
