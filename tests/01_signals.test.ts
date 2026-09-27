import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockCohort, generateMockSignals, MOCK_AS_OF_MS } from '../src/01_signals/index';
import { EnrichmentResultSchema, LeadSchema, QualificationSchema, SignalSchema } from '../src/shared/types';
import { makeLead, signal } from './helpers';

describe('01 signals: mock generation', () => {
  it('emits the three scenarios, each a valid signal-stage lead', () => {
    const leads = generateMockSignals();
    assert.deepEqual(
      leads.map(l => [l.scenario, l.lead.companyDomain]),
      [
        ['strong-fit', 'northwind-data.example'],
        ['missing-info', 'quietpeak.example'],
        ['disqualify', 'snapsnack.example'],
      ],
    );
    for (const { lead } of leads) {
      assert.ok(LeadSchema.safeParse(lead).success);
      assert.deepEqual(lead.enrichment, []);
      assert.equal(lead.qualification, null);
      assert.ok(lead.signals.every(s => s.timestamp <= MOCK_AS_OF_MS), 'no future-dated signals');
    }
  });

  it('keeps multiple distinct signals on one account', () => {
    const northwind = generateMockSignals()[0]!.lead;
    assert.equal(northwind.signals.length, 2);
    assert.equal(new Set(northwind.signals.map(s => s.id)).size, 2);
  });

  it('is deterministic for a fixed as-of time', () => {
    assert.deepEqual(generateMockSignals(), generateMockSignals());
    assert.deepEqual(generateMockCohort(), generateMockCohort());
  });

  it('builds a 10-lead cohort with unique ids and one fresh hiring signal each', () => {
    const cohort = generateMockCohort();
    assert.equal(cohort.length, 10);
    assert.equal(new Set(cohort.map(l => l.id)).size, 10);
    for (const lead of cohort) {
      assert.match(lead.companyDomain, /\.example$/);
      assert.equal(lead.signals.length, 1);
      assert.equal(lead.signals[0]!.rawData.signalType, 'hiring');
    }
  });
});

describe('01 signals: schema rejections', () => {
  it('SignalSchema rejects bad ids, timestamps and unknown keys', () => {
    assert.ok(SignalSchema.safeParse(signal()).success);
    assert.ok(!SignalSchema.safeParse(signal({ id: '  ' })).success, 'blank id');
    assert.ok(!SignalSchema.safeParse({ ...signal(), timestamp: -1 }).success, 'negative timestamp');
    assert.ok(!SignalSchema.safeParse({ ...signal(), timestamp: 1.5 }).success, 'fractional timestamp');
    assert.ok(!SignalSchema.safeParse({ ...signal(), extra: true }).success, 'unknown key');
  });

  it('LeadSchema requires a bare domain and at least one signal', () => {
    assert.ok(!LeadSchema.safeParse(makeLead({ companyDomain: 'https://acme.com/' })).success);
    assert.ok(!LeadSchema.safeParse(makeLead({ signals: [] })).success);
    assert.equal(LeadSchema.parse(makeLead({ companyDomain: 'ACME.Example' })).companyDomain, 'acme.example');
  });

  it('EnrichmentResultSchema enforces data for enriched results and whole-cent costs', () => {
    assert.ok(EnrichmentResultSchema.safeParse({ status: 'missing', data: null, source: 'apollo', costInCents: 0 }).success);
    assert.ok(!EnrichmentResultSchema.safeParse({ status: 'enriched', data: null, source: 'apollo', costInCents: 1 }).success);
    assert.ok(!EnrichmentResultSchema.safeParse({ status: 'enriched', data: {}, source: 'apollo', costInCents: 1 }).success);
    assert.ok(!EnrichmentResultSchema.safeParse({ status: 'failed', data: null, source: 'apollo', costInCents: -1 }).success);
    assert.ok(!EnrichmentResultSchema.safeParse({ status: 'failed', data: null, source: 'apollo', costInCents: 0.5 }).success);
  });

  it('QualificationSchema requires evidence, a 0-100 score and score 0 on disqualify', () => {
    const valid = { score: 85, decision: 'pass', evidence: ['140 employees'], missingFields: [] };
    assert.ok(QualificationSchema.safeParse(valid).success);
    assert.ok(!QualificationSchema.safeParse({ ...valid, evidence: [] }).success, 'empty evidence');
    assert.ok(!QualificationSchema.safeParse({ ...valid, evidence: [''] }).success, 'blank evidence line');
    assert.ok(!QualificationSchema.safeParse({ ...valid, score: 101 }).success, 'score above 100');
    assert.ok(!QualificationSchema.safeParse({ ...valid, decision: 'disqualify', score: 40 }).success, 'disqualify with score');
    assert.ok(!QualificationSchema.safeParse({ ...valid, note: 'extra' }).success, 'unknown key');
  });
});
