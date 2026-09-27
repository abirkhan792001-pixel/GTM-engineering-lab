import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateMockCohort, generateMockSignals } from '../src/01_signals/index';
import { processLead, type PipelineResult } from '../src/runPipeline';
import { buildReportModel, pdfSafe, REPORT_TITLE, writeExecutiveReport } from '../src/shared/pdfReporter';
import { CLOCKS, freshAdapters, OFFLINE } from './helpers';

// The executive PDF brief. Content is checked on the pure report model; the PDF itself is
// checked for structure, page count and (uncompressed) text.

const GENERATED_AT = new Date('2026-09-27T09:00:00Z');

async function run(leads = generateMockSignals().map(s => s.lead)): Promise<PipelineResult[]> {
  const adapters = freshAdapters();
  const results = [];
  for (const lead of leads) results.push(await processLead(lead, { clocks: CLOCKS, adapters, qualify: OFFLINE }));
  return results;
}

// Text drawn in an uncompressed pdfkit PDF: TJ arrays of hex strings split by kerning numbers.
function pdfText(path: string): string {
  const raw = readFileSync(path, 'latin1');
  return [...raw.matchAll(/\[([^\]]*)\] TJ/g)]
    .map(([, parts]) => [...parts!.matchAll(/<([0-9a-f]*)>/g)].map(([, hex]) => Buffer.from(hex!, 'hex').toString('latin1')).join(''))
    .join('\n');
}

const tmp = () => mkdtempSync(join(tmpdir(), 'gtm-report-'));

describe('report: model built from a pipeline run', () => {
  it('computes the headline metrics for the three mock leads', async () => {
    const model = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results: await run(), experiment: null });
    assert.deepEqual(model.metrics, {
      leadsProcessed: 3,
      passed: 1,
      passRatePct: 33.3,
      enrichmentCents: 8,
      contactCents: 3,
      winner: { value: 'Pending', note: 'No sends or replies yet' },
    });
    assert.deepEqual(model.outcomes.map(o => [o.domain, o.decision, o.score, o.outcome]), [
      ['northwind-data.example', 'pass', 98, 'activated'],
      ['quietpeak.example', 'hold', 67, 'manual review'],
      ['snapsnack.example', 'disqualify', 0, 'disqualified'],
    ]);
  });

  it('profiles the qualified prospect with evidence, buyer and draft', async () => {
    const [p] = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results: await run(), experiment: null }).prospects;
    assert.equal(p!.companyName, 'Northwind Data');
    assert.equal(p!.score, 98);
    assert.equal(p!.status, 'Pass');
    assert.equal(p!.scoredBy, 'Offline rubric scorer');
    assert.ok(p!.evidence.length === 4 && !p!.evidence.some(e => /^(Rubric score|Passed:)/.test(e)), 'bookkeeping lines dropped');
    assert.deepEqual(p!.buyer, { name: 'Lena Hoffmann', title: 'Director of Sales Operations', email: 'lena.hoffmann@northwind-data.example', emailStatus: 'verified' });
    assert.equal(p!.draft!.to, 'lena.hoffmann@northwind-data.example');
    assert.ok(p!.draft!.body.startsWith('Hi Lena,'));
  });

  it('profiles the held lead with its reason, missing data and evidence', async () => {
    const model = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results: await run(), experiment: null });
    assert.equal(model.held.length, 1);
    const h = model.held[0]!;
    assert.deepEqual([h.domain, h.score, h.status, h.scoredBy], ['quietpeak.example', 67, 'Hold', 'Offline rubric scorer']);
    assert.equal(h.reason, 'Cannot pass with missing required fields (hqCountry)');
    assert.deepEqual(h.missingFields, ['hqCountry']);
    assert.ok(h.evidence.length > 0 && !h.evidence.some(e => /^(Rubric score|Held:)/.test(e)), 'bookkeeping lines dropped');
  });

  it('labels Claude-scored evidence with the model and hides the scorer line', async () => {
    const [northwind, ...rest] = await run();
    const q = northwind!.lead.qualification!;
    const claudeScored = { ...northwind!, lead: { ...northwind!.lead, qualification: { ...q, evidence: ['Scored by claude-sonnet-5 against rubric icp-v2', ...q.evidence] } } };
    const [p] = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'live', results: [claudeScored, ...rest], experiment: null }).prospects;
    assert.equal(p!.scoredBy, 'Claude (claude-sonnet-5)');
    assert.ok(!p!.evidence.some(e => e.startsWith('Scored by')));
  });

  it('shows a winning variant only with engagement data, flagged when directional', async () => {
    const results = await run();
    const directional = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results, experiment: { winner: 'variant_a_pain', basis: 'meeting rate', sends: 10, enoughData: false } });
    assert.deepEqual(directional.metrics.winner, { value: 'A: pain point', note: 'Directional only: 10 sends so far' });
    const decided = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results, experiment: { winner: 'variant_b_social_proof', basis: 'meeting-booked rate 4.0% vs 2.5%', sends: 400, enoughData: true } });
    assert.deepEqual(decided.metrics.winner, { value: 'B: social proof', note: 'meeting-booked rate 4.0% vs 2.5%' });
    const tie = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results, experiment: { winner: null, basis: 'tie', sends: 20, enoughData: false } });
    assert.equal(tie.metrics.winner.value, 'Pending');
  });

  it('profiles only the highest scorers so the brief stays short', async () => {
    const results = await run([...generateMockSignals().map(s => s.lead), ...generateMockCohort()]);
    const model = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results, experiment: null });
    assert.equal(model.outcomes.length, 13, 'every lead is in the outcome table');
    assert.equal(model.prospects.length, 2);
    assert.equal(model.omittedProspects, 9);
    assert.ok(model.prospects[0]!.score >= model.prospects[1]!.score);
    assert.ok(model.prospects.every(p => p.score >= 99));
    assert.deepEqual([model.held.length, model.omittedHeld], [0, 1], 'held leads only get profile slots qualified prospects leave free');
  });

  it('handles a run with no leads', () => {
    const model = buildReportModel({ generatedAt: GENERATED_AT, dataSource: 'demo', results: [], experiment: null });
    assert.deepEqual([model.metrics.leadsProcessed, model.metrics.passRatePct, model.prospects.length], [0, 0, 0]);
  });
});

describe('report: text safety for built-in PDF fonts', () => {
  it('maps characters the standard fonts cannot draw', () => {
    assert.equal(pdfSafe('score → pass, ≥ 70'), 'score -> pass, >= 70');
    assert.equal(pdfSafe('Café • naïve – “quoted” …'), 'Café • naïve – “quoted” …');
    assert.equal(pdfSafe('rocket 🚀 and 漢字'), 'rocket ? and ??');
  });
});

describe('report: PDF output', () => {
  it('writes a two-page A4 PDF with the brief content', async () => {
    const path = join(tmp(), 'brief.pdf');
    const report = await writeExecutiveReport({ generatedAt: GENERATED_AT, dataSource: 'demo', results: await run(), experiment: null }, path, { compress: false });
    const raw = readFileSync(path, 'latin1');
    assert.ok(raw.startsWith('%PDF-'));
    assert.ok(raw.trimEnd().endsWith('%%EOF'));
    assert.equal(report.pages, 2);
    assert.match(raw, /\/MediaBox \[0 0 595\.28 841\.89\]/, 'A4');
    const text = pdfText(path);
    for (const expected of [REPORT_TITLE, 'Generated 27 Sept 2026, 09:00 UTC', 'Demo data.', 'Leads processed', '33.3%', '$0.08', 'Pending', 'Northwind Data', '98/100', 'PASS', 'Lena Hoffmann, Director of Sales Operations', 'Hi Lena,', 'Status: DRAFT, awaiting approval', 'Held for manual review (1)', 'Quietpeak', '67/100', 'HOLD', 'Why held', 'Missing data: hqCountry', 'Page 2 of 2']) {
      assert.ok(text.includes(expected), `PDF text should include "${expected}"`);
    }
  });

  it('keeps a 13-lead run to two pages', async () => {
    const path = join(tmp(), 'brief.pdf');
    const results = await run([...generateMockSignals().map(s => s.lead), ...generateMockCohort()]);
    const report = await writeExecutiveReport({ generatedAt: GENERATED_AT, dataSource: 'demo', results, experiment: null }, path, { compress: false });
    assert.equal(report.pages, 2);
    const text = pdfText(path);
    assert.ok(text.includes('Top qualified prospects (2 of 11)'));
    assert.ok(text.includes('Page 2 of 2'));
  });

  it('omits the demo banner for live runs and says when nothing qualified', async () => {
    const path = join(tmp(), 'brief.pdf');
    await writeExecutiveReport({ generatedAt: GENERATED_AT, dataSource: 'live', results: [], experiment: null }, path, { compress: false });
    const text = pdfText(path);
    assert.ok(!text.includes('Demo data.'));
    assert.ok(text.includes('No leads passed qualification in this run.'));
  });

  it('still shows the evidence when the only lead is held', async () => {
    const path = join(tmp(), 'brief.pdf');
    const report = await writeExecutiveReport({ generatedAt: GENERATED_AT, dataSource: 'live', results: await run([generateMockSignals()[1]!.lead]), experiment: null }, path, { compress: false });
    assert.equal(report.pages, 1);
    const text = pdfText(path);
    for (const expected of ['No leads passed qualification in this run.', 'Held for manual review (1)', 'HOLD', 'Reasoning and evidence', 'Cannot pass with missing required fields (hqCountry)']) {
      assert.ok(text.includes(expected), `PDF text should include "${expected}"`);
    }
  });

  it('creates the output folder if needed', async () => {
    const path = join(tmp(), 'nested', 'dir', 'brief.pdf');
    await writeExecutiveReport({ generatedAt: GENERATED_AT, dataSource: 'demo', results: [], experiment: null }, path);
    assert.ok(readFileSync(path, 'latin1').startsWith('%PDF-'));
  });
});
