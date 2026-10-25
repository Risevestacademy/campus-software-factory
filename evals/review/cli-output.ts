import { providerAdapter } from "../../src/review/index.ts";

// `claude -p --output-format json` prints the SDK result message, which is the
// final entry of the execution file the action hands the adapter in production.
export function reviewOutputFromCli(stdout: string): string {
  return providerAdapter("claude").outputFrom(`[${stdout}]`);
}
