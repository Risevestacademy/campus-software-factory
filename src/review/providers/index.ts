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
