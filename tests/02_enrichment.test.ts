import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockSignals } from '../src/01_signals/index';
import {
  enrichLead,
  enrichmentStatus,
  mergedEnrichmentData,
  missingCriticalFields,
  totalEnrichmentCostInCents,
  type EnrichmentProvider,
  type ProviderOutput,
} from '../src/02_enrichment/index';
import type { Lead } from '../src/shared/types';
import { CLOCKS, makeLead } from './helpers';

const [northwind, quietpeak, snapsnack] = generateMockSignals().map(s => s.lead) as [Lead, Lead, Lead];
const now = CLOCKS.enrich;

function provider(name: string, costInCents: number, output: ProviderOutput | (() => never)) {
  let calls = 0;
  const p: EnrichmentProvider & { calls: () => number } = {
    name,
    costInCents,
    calls: () => calls,
    async enrich() {
      calls++;
      return typeof output === 'function' ? output() : output;
    },
  };
  return p;
}

describe('02 enrichment: waterfall on the mock leads', () => {
  it('northwind-data.example uses only Apollo ($0.01)', async () => {
    const lead = await enrichLead(northwind, { now });
    assert.deepEqual(lead.enrichment.map(r => r.source), ['apollo']);
    assert.equal(totalEnrichmentCostInCents(lead), 1);
    assert.equal(enrichmentStatus(lead), 'enriched');
  });

  it('quietpeak.example falls through Apollo to Firecrawl ($0.06)', async () => {
    const lead = await enrichLead(quietpeak, { now });
    assert.deepEqual(
      lead.enrichment.map(r => [r.source, r.status, r.costInCents]),
      [
        ['apollo', 'missing', 1],
        ['firecrawl', 'enriched', 5],
      ],
    );
    assert.equal(totalEnrichmentCostInCents(lead), 6);
    assert.deepEqual(missingCriticalFields(lead), ['hqCountry']);
    assert.equal(enrichmentStatus(lead), 'missing');
  });

  it('snapsnack.example is complete after Apollo ($0.01)', async () => {
    const lead = await enrichLead(snapsnack, { now });
    assert.equal(totalEnrichmentCostInCents(lead), 1);
    assert.equal(lead.enrichment.length, 1);
  });

  it('stamps updatedAt from the injected clock and does not mutate the input', async () => {
    const lead = await enrichLead(northwind, { now });
    assert.equal(lead.updatedAt, now());
    assert.deepEqual(northwind.enrichment, []);
  });
});

describe('02 enrichment: sequencing and failure fallbacks', () => {
  const blank = makeLead({ enrichment: [] });

  it('does not call the fallback when the primary fills every critical field', async () => {
    const primary = provider('db', 1, { status: 'enriched', data: { industry: 'B2B SaaS', headcount: 50, hqCountry: 'US' } });
    const fallback = provider('scraper', 5, { status: 'enriched', data: { industry: 'x' } });
    const lead = await enrichLead(blank, { primary, fallback, now });
    assert.equal(fallback.calls(), 0);
    assert.equal(totalEnrichmentCostInCents(lead), 1);
  });

  it('an unknown domain ends as missing after Apollo miss + Firecrawl failure, billed 6 cents', async () => {
    const lead = await enrichLead(makeLead({ id: 'u', companyDomain: 'nobody.example', enrichment: [] }), { now });
    assert.deepEqual(lead.enrichment.map(r => r.status), ['missing', 'failed']);
    assert.equal(totalEnrichmentCostInCents(lead), 6);
    assert.equal(enrichmentStatus(lead), 'missing');
  });

  it('records a throwing provider as failed (still billed) and continues the waterfall', async () => {
    const primary = provider('flaky', 2, () => {
      throw new Error('timeout');
    });
    const fallback = provider('scraper', 5, { status: 'enriched', data: { industry: 'B2B SaaS', headcount: 50, hqCountry: 'US' } });
    const lead = await enrichLead(blank, { primary, fallback, now });
    assert.deepEqual(lead.enrichment[0], { status: 'failed', data: { error: 'timeout' }, source: 'flaky', costInCents: 2 });
    assert.equal(fallback.calls(), 1);
    assert.equal(totalEnrichmentCostInCents(lead), 7);
    assert.equal(enrichmentStatus(lead), 'enriched');
  });

  it('treats contract-violating provider output as failed', async () => {
    const primary = provider('bad', 1, { status: 'enriched', data: null });
    const lead = await enrichLead(blank, { primary, now });
    assert.equal(lead.enrichment[0]!.status, 'failed');
  });

  it('reports failed only when every provider failed', async () => {
    const boom = () => {
      throw new Error('down');
    };
    const lead = await enrichLead(blank, { primary: provider('a', 1, boom), fallback: provider('b', 5, boom), now });
    assert.equal(enrichmentStatus(lead), 'failed');
  });

  it('merges gaps from later providers without overwriting earlier values', async () => {
    const primary = provider('db', 1, { status: 'enriched', data: { industry: 'B2B SaaS' } });
    const fallback = provider('scraper', 5, { status: 'enriched', data: { industry: 'Other', headcount: 40, hqCountry: 'DE' } });
    const lead = await enrichLead(blank, { primary, fallback, now });
    assert.deepEqual(mergedEnrichmentData(lead), { industry: 'B2B SaaS', headcount: 40, hqCountry: 'DE' });
  });
});
