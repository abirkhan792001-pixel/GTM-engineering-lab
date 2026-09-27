import Firecrawl, { type Document, type ScrapeOptions } from '@mendable/firecrawl-js';
import { z } from 'zod';
import type { EnrichmentProvider } from './types';

// Live Firecrawl provider: scrapes the company homepage and uses Firecrawl's JSON
// extraction to pull firmographics. Used when MOCK_MODE=false and FIRECRAWL_API_KEY is set
// (see src/runtime.ts); otherwise the pipeline keeps the mock.
//
// Extracted values are untrusted page content: they are validated here, only short plain
// strings are kept, and unknowns stay null rather than being guessed. Errors are thrown and
// recorded by the waterfall as a failed (billed) step, so they never crash the pipeline.

// The only client surface we use, so tests can inject a fake with no network access.
export type FirecrawlScraper = { scrape(url: string, options: ScrapeOptions): Promise<Document> };

const Text = z.string().trim().min(1).max(80).nullable();

export const ExtractedCompanySchema = z.object({
  industry: Text,
  headcount: z.number().int().positive().max(5_000_000).nullable(),
  hqCountry: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform(v => v.toUpperCase())
    .nullable(),
  businessModel: z.enum(['B2B', 'B2C', 'B2B2C']).nullable(),
  techStack: z.array(z.string().trim().min(1).max(40)).max(30),
});
export type ExtractedCompany = z.infer<typeof ExtractedCompanySchema>;

const EXTRACTION_PROMPT = [
  "Extract facts about the company that owns this website, using only what the page states.",
  'industry: a short label such as "B2B SaaS" or "Developer Tools".',
  'headcount: number of employees only if the page states it, else null.',
  'hqCountry: ISO 3166-1 alpha-2 code of the headquarters only if stated, else null.',
  'businessModel: B2B, B2C or B2B2C only if clear from the page, else null.',
  'techStack: tools or platforms the company says it uses; empty if none.',
  'Never guess: use null when a fact is not on the page.',
].join('\n');

export interface LiveFirecrawlOptions {
  apiKey: string;
  // Injected client for tests; defaults to the real SDK client.
  client?: FirecrawlScraper;
  // Estimated cost of one JSON-extraction scrape, for cost reporting.
  costInCents?: number;
}

export function createLiveFirecrawl({ apiKey, client, costInCents = 5 }: LiveFirecrawlOptions): EnrichmentProvider {
  const scraper: FirecrawlScraper = client ?? new Firecrawl({ apiKey, timeoutMs: 60_000, maxRetries: 1 });

  return {
    name: 'firecrawl',
    costInCents,
    async enrich({ companyDomain }) {
      const url = `https://${companyDomain}/`;
      const doc = await scraper.scrape(url, {
        formats: [{ type: 'json', prompt: EXTRACTION_PROMPT, schema: z.toJSONSchema(ExtractedCompanySchema, { io: 'input' }) }],
        onlyMainContent: true,
      });

      const parsed = ExtractedCompanySchema.safeParse(doc.json);
      if (!parsed.success) {
        return { status: 'failed', data: { error: `Firecrawl returned data outside the expected shape: ${z.prettifyError(parsed.error).replace(/\s+/g, ' ')}` } };
      }
      const company = parsed.data;
      if ([company.industry, company.headcount, company.hqCountry, company.businessModel].every(v => v === null) && company.techStack.length === 0) {
        return { status: 'missing', data: null };
      }
      const pageUrl = doc.metadata?.url ?? url;
      return {
        status: 'enriched',
        data: {
          ...company,
          sources: [{ url: pageUrl, fact: 'Extracted from the company website by Firecrawl JSON mode' }],
        },
      };
    },
  };
}
