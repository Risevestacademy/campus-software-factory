import { existsSync, readFileSync } from "node:fs";

import type { ProviderId } from "../contracts.ts";
import type { ReviewProviderAdapter } from "./adapter.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";

export type { ReviewProviderAdapter } from "./adapter.ts";

const adapters: Readonly<Record<ProviderId, ReviewProviderAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function providerAdapter(id: ProviderId): ReviewProviderAdapter {
  return adapters[id];
}

export interface ProviderOutput {
  modelOutputJson: string;
  failureReason?: string;
}

export function readProviderOutput(
  path: string,
  adapter: ReviewProviderAdapter,
): ProviderOutput {
  if (!existsSync(path)) {
    return {
      modelOutputJson: "",
      failureReason: "provider step failed before writing output; see the job log",
    };
  }
  const providerFile = readFileSync(path, "utf8");
  const modelOutputJson = adapter.outputFrom(providerFile);
  const failureReason =
    modelOutputJson.length === 0
      ? adapter.failureFrom(providerFile)
      : undefined;
  return failureReason === undefined
    ? { modelOutputJson }
    : { modelOutputJson, failureReason };
}
