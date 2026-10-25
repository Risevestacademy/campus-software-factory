import type { ReviewProviderAdapter } from "./adapter.ts";

const wholeFence = /^```(?:json)?\n([\s\S]*)\n```$/;

// Only a fence wrapping the entire message is removed. JSON is never pulled
// out of prose: that would let model commentary decide a merge.
export const codexAdapter: ReviewProviderAdapter = {
  id: "codex",
  outputFrom(raw) {
    const trimmed = raw.trim();
    return wholeFence.exec(trimmed)?.[1] ?? trimmed;
  },
};
