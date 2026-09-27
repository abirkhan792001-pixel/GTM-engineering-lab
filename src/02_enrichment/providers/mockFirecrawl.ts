import type { EnrichmentProvider } from './types';

// Simulates scraping a company's homepage/about page and parsing it with an LLM.
// Slower and pricier than a database lookup, but returns deeper context and cites
// the page each fact came from. Charged per scrape attempt.

type ScrapedFact = {
  url: string;
  fact: string;
};

// Type aliases (not interfaces) so they are assignable to Record<string, unknown>.
type ScrapedProfile = {
  headcount: number | null;
  industry: string | null;
  hqCountry: string | null;
  techStack: string[];
  recentNews: string[];
  sources: ScrapedFact[];
};

const SITES: Record<string, ScrapedProfile> = {
  'quietpeak.example': {
    headcount: 45,
    industry: 'Developer Tools',
    // Remote-first: the site never states an HQ country, so it stays unknown.
    hqCountry: null,
    techStack: ['HubSpot', 'Segment', 'Snowflake'],
    recentNews: ['Announced Series A funding on the company blog'],
    sources: [
      { url: 'https://quietpeak.example/about', fact: 'About page: "a fully remote team of 45 engineers and operators"' },
      { url: 'https://quietpeak.example/', fact: 'Homepage headline: "Observability for developer platforms"' },
      { url: 'https://quietpeak.example/careers', fact: 'Job posts list HubSpot, Segment and Snowflake' },
      { url: 'https://quietpeak.example/blog/series-a', fact: 'Blog post announcing Series A' },
    ],
  },
  'northwind-data.example': {
    headcount: 140,
    industry: 'B2B SaaS',
    hqCountry: 'DE',
    techStack: ['Salesforce', 'Outreach', 'dbt'],
    recentNews: [],
    sources: [{ url: 'https://northwind-data.example/about', fact: 'About page: "140 people across Berlin and Munich"' }],
  },
};

export const mockFirecrawl: EnrichmentProvider = {
  name: 'firecrawl',
  costInCents: 5,
  async enrich({ companyDomain }) {
    const profile = SITES[companyDomain];
    if (!profile) return { status: 'failed', data: { error: `Could not scrape https://${companyDomain}/` } };
    return { status: 'enriched', data: structuredClone(profile) };
  },
};
