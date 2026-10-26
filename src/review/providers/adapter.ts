import type { ProviderId } from "../contracts.ts";

export type ProviderFailureKind = "technical" | "usage-limit";

export interface ProviderFailure {
  kind: ProviderFailureKind;
  reason: string;
  refillAt?: string;
}

export interface ReviewProviderAdapter {
  id: ProviderId;
  outputFrom(providerFile: string): string;
  failureFrom(providerFile: string): ProviderFailure | undefined;
}
