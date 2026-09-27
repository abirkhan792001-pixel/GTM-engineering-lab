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
// Likewise no test may reach Ollama, Firecrawl, Slack or Resend: live adapters are only ever built
// with injected fakes, and real credentials from the shell are cleared.
process.env.MOCK_MODE = 'true';
for (const key of ['OLLAMA_MODEL', 'OLLAMA_BASE_URL', 'FIRECRAWL_API_KEY', 'SLACK_WEBHOOK_URL', 'RESEND_API_KEY', 'RESEND_FROM', 'DRAFT_REVIEW_EMAIL', 'ATTIO_API_KEY', 'HUBSPOT_API_KEY', 'WEBHOOK_SECRET']) {
  delete process.env[key];
}

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

// A fake fetch that records requests and answers with a fixed status and body (or throws).
export function fakeFetch(respond: { status?: number; body?: string } | (() => never) = {}) {
  const calls: { url: string; init: RequestInit; json: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) });
    if (typeof respond === 'function') return respond();
    const status = respond.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => respond.body ?? '' };
  };
  return { fetch, calls };
}

// A fake Ollama /api/chat endpoint: records requests and streams a fixed message content
// (an object is sent as JSON, a string as-is) the way Ollama does, as newline-delimited
// JSON chunks and a final line with done_reason. Or replies with an error status, or throws.
export function fakeOllama(respond: { content?: unknown; status?: number; doneReason?: string } | (() => never) = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (typeof respond === 'function') return respond();
    const status = respond.status ?? 200;
    const ok = status >= 200 && status < 300;
    const content = typeof respond.content === 'string' ? respond.content : JSON.stringify(respond.content ?? {});
    const half = Math.ceil(content.length / 2);
    const stream = [content.slice(0, half), content.slice(half)]
      .map(part => JSON.stringify({ message: { role: 'assistant', content: part }, done: false }))
      .concat(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: respond.doneReason ?? 'stop' }))
      .join('\n');
    return { ok, status, text: async () => (ok ? stream : content) };
  };
  return { fetch, calls };
}

// A fake Firecrawl client returning a fixed extraction (or throwing).
export function fakeFirecrawl(json: unknown | (() => never)) {
  const calls: { url: string; options: unknown }[] = [];
  const client = {
    async scrape(url: string, options: unknown) {
      calls.push({ url, options });
      return { json: typeof json === 'function' ? (json as () => never)() : json, metadata: { url } };
    },
  };
  return { client, calls };
}
