import {
  EnrichmentResultSchema,
  LeadSchema,
  type EnrichmentResult,
  type EnrichmentStatus,
  type Lead,
} from '../shared/types';
import { mockApollo } from './providers/mockApollo';
import { mockFirecrawl } from './providers/mockFirecrawl';
import type { EnrichmentProvider } from './providers/types';
import { ICP } from '../shared/icp';

// Waterfall enrichment: always run the cheap database lookup first, and only pay
// for the deep scraper when critical firmographics are still missing.

// The fields the qualification hard gates need (from src/context/icp.json), so the
// waterfall pays for exactly the data qualification cannot work without.
export const CRITICAL_FIELDS: readonly string[] = ICP.qualification.requiredFields;

export interface EnrichOptions {
  primary?: EnrichmentProvider;
  fallback?: EnrichmentProvider;
  // Injected clock so runs can be replayed with identical timestamps.
  now?: () => number;
}

// Merge data from every successful result. Earlier (cheaper, already trusted)
// providers win; later providers only fill gaps and never overwrite a known value.
export function mergedEnrichmentFields(lead: Lead): Record<string, { value: unknown; source: string }> {
  const merged: Record<string, { value: unknown; source: string }> = {};
  for (const result of lead.enrichment) {
    if (result.status !== 'enriched' || !result.data) continue;
    for (const [key, value] of Object.entries(result.data)) {
      if (isPresent(value) && !merged[key]) merged[key] = { value, source: result.source };
    }
  }
  return merged;
}

export function mergedEnrichmentData(lead: Lead): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mergedEnrichmentFields(lead)).map(([key, field]) => [key, field.value]));
}

// Only verified enrichment counts: unverified signal rawData never satisfies a critical field.
export function missingCriticalFields(lead: Lead): string[] {
  const data = mergedEnrichmentData(lead);
  return CRITICAL_FIELDS.filter(field => !isPresent(data[field]));
}

export function totalEnrichmentCostInCents(lead: Lead): number {
  return lead.enrichment.reduce((sum, result) => sum + result.costInCents, 0);
}

export function enrichmentStatus(lead: Lead): EnrichmentStatus {
  if (missingCriticalFields(lead).length === 0) return 'enriched';
  if (lead.enrichment.length > 0 && lead.enrichment.every(result => result.status === 'failed')) return 'failed';
  return 'missing';
}

export async function enrichLead(lead: Lead, options: EnrichOptions = {}): Promise<Lead> {
  const { primary = mockApollo, fallback = mockFirecrawl, now = Date.now } = options;

  let next: Lead = { ...lead, enrichment: [...lead.enrichment] };

  next.enrichment.push(await runProvider(primary, next));

  if (missingCriticalFields(next).length > 0) {
    next.enrichment.push(await runProvider(fallback, next));
  }

  next = { ...next, updatedAt: now() };
  return LeadSchema.parse(next);
}

async function runProvider(provider: EnrichmentProvider, lead: Lead): Promise<EnrichmentResult> {
  const base = { source: provider.name, costInCents: provider.costInCents };
  try {
    const output = await provider.enrich({
      companyDomain: lead.companyDomain,
      missingFields: missingCriticalFields(lead),
    });
    // Provider output is untrusted: validate it against the shared contract.
    return EnrichmentResultSchema.parse({ ...output, ...base });
  } catch (error) {
    // A provider error must not break the waterfall. Record it as failed and
    // assume the call was billed, so reported cost never understates spend.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', data: { error: message }, ...base };
  }
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}
