import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LeadSchema, type Lead } from '../shared/types';

// Mock signal generator. Emits three synthetic leads that exercise the paths the
// later stages must handle: a strong fit, an edge case with missing firmographics,
// and a clear disqualify. Domains use the reserved `.example` TLD; no real companies.

export type MockScenario = 'strong-fit' | 'missing-info' | 'disqualify';

// Fixed evaluation time so repeated runs emit identical output.
export const MOCK_AS_OF_MS = Date.UTC(2026, 8, 27, 9, 0, 0);
const DAY_MS = 86_400_000;

interface MockLead {
  scenario: MockScenario;
  lead: unknown; // validated against LeadSchema before it leaves this module
}

function mockLeads(asOfMs: number): MockLead[] {
  return [
    {
      scenario: 'strong-fit',
      lead: {
        id: 'lead_northwind-data',
        companyDomain: 'northwind-data.example',
        signals: [
          {
            id: 'sig_northwind_hiring_001',
            source: 'job-board',
            timestamp: asOfMs - 2 * DAY_MS,
            rawData: {
              signalType: 'hiring',
              companyName: 'Northwind Data',
              jobTitle: 'Head of Revenue Operations',
              jobUrl: 'https://northwind-data.example/careers/head-of-revops',
              industry: 'B2B SaaS',
              employeeCount: 140,
              country: 'DE',
            },
          },
          {
            id: 'sig_northwind_pricing_002',
            source: 'website-visit',
            timestamp: asOfMs - 1 * DAY_MS,
            rawData: { signalType: 'pricing-page-visit', pagePath: '/pricing', visits: 3 },
          },
        ],
        enrichment: [],
        qualification: null,
        createdAt: asOfMs,
        updatedAt: asOfMs,
      },
    },
    {
      scenario: 'missing-info',
      lead: {
        id: 'lead_quietpeak',
        companyDomain: 'quietpeak.example',
        signals: [
          {
            id: 'sig_quietpeak_visit_001',
            source: 'website-visit',
            timestamp: asOfMs - 12 * DAY_MS,
            // No industry, headcount or country: enrichment must fill these or
            // qualification must list them as missingFields and hold.
            rawData: { signalType: 'pricing-page-visit', pagePath: '/pricing', visits: 1 },
          },
        ],
        enrichment: [],
        qualification: null,
        createdAt: asOfMs,
        updatedAt: asOfMs,
      },
    },
    {
      scenario: 'disqualify',
      lead: {
        id: 'lead_snapsnack',
        companyDomain: 'snapsnack.example',
        signals: [
          {
            id: 'sig_snapsnack_engagement_001',
            source: 'linkedin-engagement',
            timestamp: asOfMs - 3 * DAY_MS,
            // Hits two ICP dealbreakers: consumer-only model and fewer than 10 employees.
            rawData: {
              signalType: 'post-comment',
              companyName: 'SnapSnack',
              industry: 'Consumer Mobile Apps',
              businessModel: 'B2C',
              employeeCount: 6,
              country: 'US',
            },
          },
        ],
        enrichment: [],
        qualification: null,
        createdAt: asOfMs,
        updatedAt: asOfMs,
      },
    },
  ];
}

export function generateMockSignals(asOfMs: number = MOCK_AS_OF_MS): { scenario: MockScenario; lead: Lead }[] {
  return mockLeads(asOfMs).map(({ scenario, lead }) => {
    const parsed = LeadSchema.safeParse(lead);
    if (!parsed.success) {
      throw new Error(`Mock lead for scenario '${scenario}' failed LeadSchema:\n${z.prettifyError(parsed.error)}`);
    }
    return { scenario, lead: parsed.data };
  });
}

function main(): void {
  const leads = generateMockSignals();
  console.log(`[01_signals] emitted ${leads.length} leads (as_of ${new Date(MOCK_AS_OF_MS).toISOString()})\n`);
  for (const { scenario, lead } of leads) {
    console.log(`--- ${scenario}: ${lead.companyDomain} (${lead.signals.length} signal${lead.signals.length === 1 ? '' : 's'}) ---`);
    console.log(JSON.stringify(lead, null, 2));
    console.log();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
