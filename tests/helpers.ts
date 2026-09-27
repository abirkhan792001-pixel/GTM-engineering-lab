import { MOCK_AS_OF_MS } from '../src/01_signals/index';
import { mockScoreRubric } from '../src/03_qualification/index';
import { createMockCRM, createMockEmail, createMockNotifier } from '../src/05_activation/index';
import { assignVariant, type VariantId } from '../src/06_learning/index';
import type { Contact, EnrichmentResult, Lead, Qualification, Signal } from '../src/shared/types';

// Shared fixtures for the test suite. Everything is synthetic and deterministic.

// No test may reach the real Anthropic API. Any Claude client created by default code
// gets a dummy key and an unroutable base URL, so a test that forgets to inject a fake
// client or the offline scorer fails loudly instead of spending credits. The SDK reads
// both variables when a client is constructed, which only happens lazily inside a test.
process.env.ANTHROPIC_API_KEY = 'test-key-no-network';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
delete process.env.QUALIFIER_MODEL;

// Qualification options that score with the deterministic offline scorer.
export const OFFLINE = { scorer: mockScoreRubric } as const;

export const NOW = MOCK_AS_OF_MS;
export const DAY_MS = 86_400_000;

// Fixed stage clocks, matching the dev runners.
export const CLOCKS = {
  enrich: () => NOW + 60_000,
  qualify: () => NOW + 120_000,
  contacts: () => NOW + 150_000,
  activate: () => NOW + 180_000,
};

export function signal(overrides: Partial<Signal> & { ageDays?: number; rawData?: Record<string, unknown> } = {}): Signal {
  const { ageDays = 1, ...rest } = overrides;
  return {
    id: 'sig_test_001',
    source: 'job-board',
    timestamp: NOW - ageDays * DAY_MS,
    rawData: { signalType: 'hiring', jobTitle: 'Head of Sales' },
    ...rest,
  };
}

export function enriched(data: Record<string, unknown>, source = 'apollo', costInCents = 1): EnrichmentResult {
  return { status: 'enriched', data, source, costInCents };
}

// A lead that clears every gate and scores full firmographic points (70) before intent.
export const TARGET_FIRMOGRAPHICS = { industry: 'B2B SaaS', headcount: 100, hqCountry: 'US' };

export function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead_test',
    companyDomain: 'test.example',
    signals: [signal()],
    enrichment: [enriched(TARGET_FIRMOGRAPHICS)],
    qualification: null,
    contact: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function passQualification(evidence: string[] = ['Fresh hiring signal via job-board [sig_test_001]']): Qualification {
  return { score: 90, decision: 'pass', evidence, missingFields: [] };
}

// A contact as 04_contacts records it for a verified buyer, verified at NOW.
export function verifiedContact(overrides: Partial<Contact> = {}): Contact {
  return {
    status: 'verified',
    person: { fullName: 'Lena Hoffmann', title: 'Director of Sales Operations', personaId: 'revops-leader' },
    email: 'lena.hoffmann@test.example',
    emailStatus: 'valid',
    verifiedAt: NOW,
    steps: [
      { step: 'person_search', source: 'apollo-people', status: 'found', costInCents: 1 },
      { step: 'email_finder', source: 'email-finder', status: 'found', costInCents: 2 },
    ],
    reason: 'Lena Hoffmann, Director of Sales Operations: email verified',
    ...overrides,
  };
}

// Fresh adapter instances per test, so no state leaks between tests.
export function freshAdapters() {
  return { crm: createMockCRM(), email: createMockEmail(), notifier: createMockNotifier() };
}

// Collect lead ids that hash to each variant, for tracker tests.
export function idsByVariant(perVariant: number): Record<VariantId, string[]> {
  const ids: Record<VariantId, string[]> = { variant_a_pain: [], variant_b_social_proof: [] };
  for (let i = 0; ids.variant_a_pain.length < perVariant || ids.variant_b_social_proof.length < perVariant; i++) {
    const id = `lead_t${i}`;
    const bucket = ids[assignVariant(id).id];
    if (bucket.length < perVariant) bucket.push(id);
  }
  return ids;
}
