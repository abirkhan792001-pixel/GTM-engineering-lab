import { z } from 'zod';
import { LEARNING_COHORT } from '../shared/mockCompanies';
import { LeadSchema, type Lead } from '../shared/types';

export { IntakeError, INTENT_EVENT_TYPES, IntentSignalSchema, intentToLead, LINKEDIN_ENGAGEMENTS, normalizeDomain, type IntentSignal } from './intake';
export { mergeByDomain, mergeLead } from './merge';

// Mock signal generator. Emits four synthetic leads that exercise the paths the
// later stages must handle: a strong fit, an edge case with missing firmographics,
// a clear disqualify and an inbound demo request. Domains use the reserved `.example`
// TLD; no real companies or people.

export type MockScenario = 'strong-fit' | 'missing-info' | 'disqualify' | 'hand-raise';

// Fixed evaluation time so repeated runs emit identical output.
export const MOCK_AS_OF_MS = Date.UTC(2026, 8, 27, 9, 0, 0);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
          {
            // Names the person, so 04_contacts addresses them instead of searching for a buyer.
            id: 'sig_northwind_linkedin_003',
            source: 'linkedin',
            timestamp: asOfMs - 12 * HOUR_MS,
            rawData: { signalType: 'linkedin-own-post-engagement', contactName: 'Lena Hoffmann', contactTitle: 'Director of Sales Operations' },
          },
        ],
        enrichment: [],
        qualification: null,
        contact: null,
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
        contact: null,
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
            source: 'linkedin',
            timestamp: asOfMs - 3 * DAY_MS,
            // Hits two ICP dealbreakers: consumer-only model and fewer than 10 employees.
            rawData: {
              signalType: 'linkedin-competitor-post-engagement',
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
        contact: null,
        createdAt: asOfMs,
        updatedAt: asOfMs,
      },
    },
    {
      scenario: 'hand-raise',
      lead: {
        id: 'lead_ravenhill',
        companyDomain: 'ravenhill.example',
        signals: [
          {
            // A demo request skips outreach: 05_activation hands it straight to sales.
            id: 'sig_ravenhill_demo_001',
            source: 'website',
            timestamp: asOfMs - 4 * HOUR_MS,
            rawData: {
              signalType: 'demo-request',
              companyName: 'Ravenhill',
              contactName: 'Sam Okafor',
              contactTitle: 'VP Revenue Operations',
              contactEmail: 'sam.okafor@ravenhill.example',
            },
          },
        ],
        enrichment: [],
        qualification: null,
        contact: null,
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

// Ten synthetic ICP-fit accounts, each with one fresh hiring signal. Used by the
// 06_learning A/B runner so a full batch reaches activation and gets drafted.
export function generateMockCohort(asOfMs: number = MOCK_AS_OF_MS): Lead[] {
  return LEARNING_COHORT.map(company => {
    const slug = company.domain.split('.')[0]!;
    const parsed = LeadSchema.safeParse({
      id: `lead_${slug}`,
      companyDomain: company.domain,
      signals: [
        {
          id: `sig_${slug}_hiring_001`,
          source: 'job-board',
          timestamp: asOfMs - company.signalAgeDays * DAY_MS,
          rawData: { signalType: 'hiring', companyName: company.name, jobTitle: company.hiringFor },
        },
      ],
      enrichment: [],
      qualification: null,
      contact: null,
      createdAt: asOfMs,
      updatedAt: asOfMs,
    });
    if (!parsed.success) throw new Error(`Cohort lead ${company.domain} failed LeadSchema:\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}
