import { z } from 'zod';
import { CompanyDomainSchema, LeadSchema, type Lead } from '../shared/types';
import { normalizeDomain } from './intake';
import { mergeByDomain } from './merge';

// Layer 1 of allbound: pull target accounts from several list providers (BlitzAPI, Sales
// Navigator, Prospeo, AI Ark, Ocean.io, ...) and dedupe them into one lead per company domain.
//
// Each listing becomes an 'account-list' signal (warmth tier 2, fit only) on the account, so an
// account found by three providers is one lead with three signals, and a later engagement or
// hand-raise lands on that same lead. List records are untrusted: only the domain and a short
// company name are kept, and neither counts as verified company data (02_enrichment does that).
// A provider that fails is reported and skipped; the others still run.

export const SourcedAccountSchema = z.object({
  // A bare domain or a URL; normalised to the company domain.
  website: z.string().trim().min(1).max(300),
  companyName: z.string().trim().min(1).max(120).optional(),
});
export type SourcedAccount = z.infer<typeof SourcedAccountSchema>;

export interface AccountListProvider {
  name: string;
  // Charged per record returned.
  costPerRecordInCents: number;
  fetchAccounts(): Promise<unknown[]>;
}

export interface SourceReport {
  source: string;
  status: 'ok' | 'failed';
  fetched: number;
  // Records with no usable company domain.
  rejected: number;
  costInCents: number;
  error?: string;
}

export interface SourcingResult {
  leads: Lead[];
  sources: SourceReport[];
  // Listings that pointed at an account another listing already found.
  duplicates: number;
}

export async function sourceAccounts(providers: AccountListProvider[], { now = Date.now() }: { now?: number } = {}): Promise<SourcingResult> {
  const leads: Lead[] = [];
  const sources: SourceReport[] = [];

  for (const provider of providers) {
    let records: unknown[];
    try {
      records = await provider.fetchAccounts();
    } catch (error) {
      sources.push({ source: provider.name, status: 'failed', fetched: 0, rejected: 0, costInCents: 0, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let rejected = 0;
    const seenInList = new Set<string>();
    for (const record of records) {
      const lead = toLead(record, provider.name, now);
      // A provider that lists the same account twice adds one signal, not two.
      if (!lead || seenInList.has(lead.companyDomain)) {
        if (!lead) rejected++;
        continue;
      }
      seenInList.add(lead.companyDomain);
      leads.push(lead);
    }
    sources.push({ source: provider.name, status: 'ok', fetched: records.length, rejected, costInCents: records.length * provider.costPerRecordInCents });
  }

  const merged = mergeByDomain(leads);
  return { leads: merged, sources, duplicates: leads.length - merged.length };
}

function toLead(record: unknown, source: string, now: number): Lead | null {
  const parsed = SourcedAccountSchema.safeParse(record);
  if (!parsed.success) return null;
  const domain = CompanyDomainSchema.safeParse(normalizeDomain(parsed.data.website));
  if (!domain.success) return null;
  const slug = domain.data.split('.')[0]!.replace(/[^a-z0-9]+/g, '-');
  const sourceSlug = source.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return LeadSchema.parse({
    id: `lead_${slug}`,
    companyDomain: domain.data,
    signals: [
      {
        id: `sig_${slug}_list_${sourceSlug}`,
        source,
        timestamp: now,
        rawData: { signalType: 'account-list', ...(parsed.data.companyName && { companyName: parsed.data.companyName }) },
      },
    ],
    enrichment: [],
    qualification: null,
    contact: null,
    createdAt: now,
    updatedAt: now,
  });
}
