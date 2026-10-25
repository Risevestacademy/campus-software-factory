import type { ReviewProviderAdapter } from "./adapter.ts";

export const claudeAdapter: ReviewProviderAdapter = {
  id: "claude",
  outputFrom: (raw) => raw.trim(),
};
