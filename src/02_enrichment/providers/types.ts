import type { EnrichmentResult } from '../../shared/types';

export interface ProviderInput {
  companyDomain: string;
  // Fields earlier providers could not fill; a provider may focus its lookup on these.
  missingFields: readonly string[];
}

// Providers report only what they found. The orchestrator stamps `source` and
// `costInCents` from the provider definition so cost has one source of truth.
export type ProviderOutput = Pick<EnrichmentResult, 'status' | 'data'>;

export interface EnrichmentProvider {
  name: string;
  costInCents: number;
  enrich(input: ProviderInput): Promise<ProviderOutput>;
}
