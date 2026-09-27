import type { EnrichmentProvider } from './types';

// Simulates a fast firmographic database lookup: basic headcount, industry and HQ
// country only. No tech stack or recent news. Charged per lookup, hit or miss.

const DATABASE: Record<string, { headcount: number; industry: string; hqCountry: string }> = {
  'northwind-data.example': { headcount: 140, industry: 'B2B SaaS', hqCountry: 'DE' },
  'snapsnack.example': { headcount: 6, industry: 'Consumer Mobile Apps', hqCountry: 'US' },
  // quietpeak.example is intentionally absent: a young company the database has not indexed.
};

export const mockApollo: EnrichmentProvider = {
  name: 'apollo',
  costInCents: 1,
  async enrich({ companyDomain }) {
    const record = DATABASE[companyDomain];
    if (!record) return { status: 'missing', data: null };
    return { status: 'enriched', data: { ...record } };
  },
};
