import { LeadSchema, type Lead, type Signal } from '../shared/types';

// One lead per account. Signals for the same company domain are combined onto one lead, so
// the warmest of them can decide what happens next. Exact repeats (same source, time and
// payload, e.g. a retried webhook) are dropped; distinct signals are all kept.

const signalKey = (signal: Signal) => JSON.stringify([signal.source, signal.timestamp, signal.rawData]);

// Adds incoming's new signals to existing, keeping existing's id. Returns null when incoming
// adds nothing new. Downstream results are cleared: a merged lead re-runs from enrichment.
export function mergeLead(existing: Lead, incoming: Lead, now: number = Math.max(existing.updatedAt, incoming.updatedAt)): Lead | null {
  if (existing.companyDomain !== incoming.companyDomain) {
    throw new Error(`Cannot merge ${incoming.companyDomain} into ${existing.companyDomain}: different accounts`);
  }
  const seen = new Set(existing.signals.map(signalKey));
  const added: Signal[] = [];
  for (const signal of incoming.signals) {
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(signal);
  }
  if (added.length === 0) return null;
  return LeadSchema.parse({
    ...existing,
    signals: [...existing.signals, ...added],
    enrichment: [],
    qualification: null,
    contact: null,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: now,
  });
}

// Collapses a batch to one lead per domain, in first-seen order.
export function mergeByDomain(leads: Lead[]): Lead[] {
  const byDomain = new Map<string, Lead>();
  for (const lead of leads) {
    const existing = byDomain.get(lead.companyDomain);
    byDomain.set(lead.companyDomain, existing ? (mergeLead(existing, lead) ?? existing) : lead);
  }
  return [...byDomain.values()];
}
