import type { ProviderId } from "../contracts.ts";

export interface ReviewProviderAdapter {
  id: ProviderId;
  outputFrom(raw: string): string;
}
