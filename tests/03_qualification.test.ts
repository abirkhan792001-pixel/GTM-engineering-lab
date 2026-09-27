import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockSignals } from '../src/01_signals/index';
import { enrichLead } from '../src/02_enrichment/index';
import { decide, evaluateICP, mockScoreRubric } from '../src/03_qualification/evaluator';
import { qualifyLead } from '../src/03_qualification/index';
import { checkHardGates } from '../src/03_qualification/rules';
import { ICP, IcpSchema } from '../src/shared/icp';
import type { Lead, Qualification } from '../src/shared/types';
import { CLOCKS, enriched, makeLead, NOW, signal, TARGET_FIRMOGRAPHICS } from './helpers';

async function qualifyMock(index: number): Promise<Qualification> {
  const lead = generateMockSignals()[index]!.lead;
  const q = (await qualifyLead(await enrichLead(lead, { now: CLOCKS.enrich }), { now: CLOCKS.qualify })).qualification;
  assert.ok(q);
  return q;
}

const qualify = async (lead: Lead) => (await qualifyLead(lead, { now: () => NOW })).qualification!;
const withFirmographics = (data: Record<string, unknown>) => makeLead({ enrichment: [enriched(data)] });

describe('03 qualification: end-to-end on the mock leads', () => {
  it('northwind-data.example passes with a high score and cited evidence', async () => {
    const q = await qualifyMock(0);
    assert.equal(q.decision, 'pass');
    assert.equal(q.score, 98);
    assert.deepEqual(q.missingFields, []);
    assert.ok(q.evidence.some(e => e.startsWith("Industry 'B2B SaaS' is a target industry (+30) [apollo]")));
  });

  it('quietpeak.example is held with hqCountry missing', async () => {
    const q = await qualifyMock(1);
    assert.equal(q.decision, 'hold');
    assert.equal(q.score, 67);
    assert.deepEqual(q.missingFields, ['hqCountry']);
  });

  it('snapsnack.example is disqualified at the hard gates with score 0', async () => {
    const lead = await enrichLead(generateMockSignals()[2]!.lead, { now: CLOCKS.enrich });
    const gate = checkHardGates(lead);
    assert.ok(gate, 'gates should fire');
    assert.equal(gate.score, 0);
    assert.equal(gate.decision, 'disqualify');
    assert.deepEqual(gate.evidence, [
      'Hit dealbreaker: Headcount (6) is under minimum threshold of 10 [apollo]',
      "Hit dealbreaker: Industry 'Consumer Mobile Apps' matches excluded keyword 'consumer' [apollo]",
    ]);
  });
});

describe('03 qualification: hard gate dealbreakers', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['headcount under the minimum', { ...TARGET_FIRMOGRAPHICS, headcount: 9 }, /^Hit dealbreaker: Headcount \(9\) is under minimum threshold of 10/],
    ['excluded business model', { ...TARGET_FIRMOGRAPHICS, businessModel: 'b2c' }, /^Hit dealbreaker: Business model 'b2c' is excluded/],
    ['excluded industry keyword', { ...TARGET_FIRMOGRAPHICS, industry: 'Marketing Agency' }, /^Hit dealbreaker: Industry 'Marketing Agency' matches excluded keyword 'agency'/],
    ['non-target country', { ...TARGET_FIRMOGRAPHICS, hqCountry: 'BR' }, /^Hit dealbreaker: HQ country 'BR' is not a target country/],
  ];
  for (const [name, data, pattern] of cases) {
    it(`disqualifies on ${name} with score 0`, async () => {
      const q = await qualify(withFirmographics(data));
      assert.equal(q.decision, 'disqualify');
      assert.equal(q.score, 0);
      assert.match(q.evidence[0]!, pattern);
    });
  }

  it('never fires on unknown values', () => {
    assert.equal(checkHardGates(makeLead({ enrichment: [] })), null);
  });

  it('headcount between the gate (10) and the target range (20) passes the gate but earns no size points', async () => {
    const q = await qualify(withFirmographics({ ...TARGET_FIRMOGRAPHICS, headcount: 12 }));
    assert.notEqual(q.decision, 'disqualify');
    assert.ok(q.evidence.some(e => e.startsWith('Headcount 12 is outside target range 20-500 (+0)')));
  });
});

describe('03 qualification: signal age decay', () => {
  // TARGET_FIRMOGRAPHICS scores 70; the rest is intent. Hiring is worth up to 30.
  const scoreWith = async (...signals: ReturnType<typeof signal>[]) =>
    (await mockScoreRubric(makeLead({ signals }), { asOfMs: NOW, icp: ICP })).score;

  it('decays linearly to zero at maxSignalAgeDays', async () => {
    assert.equal(await scoreWith(signal({ ageDays: 0 })), 100);
    assert.equal(await scoreWith(signal({ ageDays: 15 })), 85);
    assert.equal(await scoreWith(signal({ ageDays: 30 })), 70);
    assert.equal(await scoreWith(signal({ ageDays: 31 })), 70);
  });

  it('weights signal types from icp.json (pricing-page visit worth 20)', async () => {
    assert.equal(await scoreWith(signal({ ageDays: 0, rawData: { signalType: 'pricing-page-visit' } })), 90);
    assert.equal(await scoreWith(signal({ ageDays: 0, rawData: { signalType: 'something-else' } })), 80);
  });

  it('ignores future-dated signals', async () => {
    assert.equal(await scoreWith(signal({ ageDays: -2 })), 70);
  });

  it('counts only the strongest fresh signal', async () => {
    const score = await scoreWith(
      signal({ id: 'a', ageDays: 20, rawData: { signalType: 'hiring' } }),
      signal({ id: 'b', ageDays: 0, rawData: { signalType: 'pricing-page-visit' } }),
    );
    assert.equal(score, 90);
  });

  it('records a stale-only lead as having no fresh intent', async () => {
    const rubric = await mockScoreRubric(makeLead({ signals: [signal({ ageDays: 45 })] }), { asOfMs: NOW, icp: ICP });
    assert.ok(rubric.evidence.includes('No fresh intent signal within 30 days (+0)'));
  });
});

describe('03 qualification: decisions and evidence', () => {
  it('always returns at least one evidence line, for every decision', async () => {
    const leads = [
      withFirmographics(TARGET_FIRMOGRAPHICS),
      makeLead({ enrichment: [] }),
      withFirmographics({ industry: 'Logistics', headcount: 800, hqCountry: 'US' }),
      withFirmographics({ ...TARGET_FIRMOGRAPHICS, headcount: 3 }),
    ];
    const decisions = new Set<string>();
    for (const lead of leads) {
      const q = await qualify(lead);
      decisions.add(q.decision);
      assert.ok(q.evidence.length > 0 && q.evidence.every(e => e.trim().length > 0));
    }
    assert.deepEqual([...decisions].sort(), ['disqualify', 'hold', 'pass']);
  });

  it('disqualifies a poor fit with score 0 and a Poor fit reason', async () => {
    const q = await qualify(makeLead({ enrichment: [enriched({ industry: 'Logistics', headcount: 800, hqCountry: 'US' })], signals: [signal({ ageDays: 40 })] }));
    assert.equal(q.decision, 'disqualify');
    assert.equal(q.score, 0);
    assert.ok(q.evidence.some(e => e.startsWith('Poor fit: best possible score 15 is below the hold threshold of 40')));
  });

  it('holds (never disqualifies) a lead whose only problem is missing data', async () => {
    const q = await qualify(makeLead({ enrichment: [], signals: [signal({ ageDays: 50 })] }));
    assert.equal(q.decision, 'hold');
    assert.deepEqual(q.missingFields, ['industry', 'headcount', 'hqCountry']);
  });

  it('holds a high score when a required field is missing', () => {
    const q = decide({ score: 85, evidence: ['x'], missingFields: ['hqCountry'], unscoredPoints: 15 });
    assert.equal(q.decision, 'hold');
    assert.equal(q.score, 85);
  });

  it('holds a complete lead scoring between the hold and pass thresholds', () => {
    assert.equal(decide({ score: 55, evidence: ['x'], missingFields: [], unscoredPoints: 0 }).decision, 'hold');
  });

  it('lets a custom scorer be swapped in while decide() stays in control', async () => {
    const q = await evaluateICP(makeLead(), { scorer: async () => ({ score: 10, evidence: ['custom'], missingFields: [], unscoredPoints: 0 }) });
    assert.equal(q.decision, 'disqualify');
    assert.equal(q.score, 0);
  });

  it('rejects an ICP config whose rubric does not sum to 100', () => {
    const bad = { ...ICP, scoring: { ...ICP.scoring, weights: { ...ICP.scoring.weights, industry: 50 } } };
    assert.ok(!IcpSchema.safeParse(bad).success);
  });
});
