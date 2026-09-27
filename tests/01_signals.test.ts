import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { generateMockCohort, generateMockSignals, IntakeError, IntentSignalSchema, intentToLead, MOCK_AS_OF_MS, normalizeDomain } from '../src/01_signals/index';
import { createSignalServer } from '../src/01_signals/server';
import { buildRuntime } from '../src/runtime';
import { loadConfig } from '../src/shared/config';
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

describe('01 signals: webhook intake', () => {
  const now = MOCK_AS_OF_MS;
  const id = () => 'abc123';

  it('turns a contact form into a lead keyed by the email domain', () => {
    const lead = intentToLead(IntentSignalSchema.parse({ eventType: 'contact_form', source: 'website', email: 'lena@Northwind-Data.example', name: 'Lena' }), { now, id });
    assert.equal(lead.id, 'lead_northwind-data_abc123');
    assert.equal(lead.companyDomain, 'northwind-data.example');
    assert.deepEqual(lead.signals[0]!.rawData, { signalType: 'contact-form', contactName: 'Lena', contactEmail: 'lena@Northwind-Data.example' });
    assert.equal(lead.contact, null);
  });

  it('normalises URLs to bare domains and prefers companyDomain over the email domain', () => {
    const lead = intentToLead(IntentSignalSchema.parse({ eventType: 'signup', source: 'app', companyDomain: 'https://www.Acme.example:443/pricing?x=1', email: 'a@other.example' }), { now, id });
    assert.equal(lead.companyDomain, 'acme.example');
    assert.equal(normalizeDomain('HTTP://www.foo.bar.example/'), 'foo.bar.example');
  });

  it('rejects personal email domains unless a company domain is given', () => {
    assert.throws(() => intentToLead(IntentSignalSchema.parse({ eventType: 'signup', source: 'app', email: 'someone@gmail.com' }), { now }), IntakeError);
    const lead = intentToLead(IntentSignalSchema.parse({ eventType: 'signup', source: 'app', email: 'someone@gmail.com', companyDomain: 'acme.example' }), { now, id });
    assert.equal(lead.companyDomain, 'acme.example');
  });

  it('never records a future signal and keeps metadata in rawData', () => {
    const lead = intentToLead(IntentSignalSchema.parse({ eventType: 'demo_request', source: 'x', companyDomain: 'acme.example', occurredAt: '2099-01-01T00:00:00Z', metadata: { plan: 'pro' } }), { now, id });
    assert.equal(lead.signals[0]!.timestamp, now);
    assert.deepEqual(lead.signals[0]!.rawData.metadata, { plan: 'pro' });
  });

  it('validates the IntentSignal schema', () => {
    const ok = { eventType: 'signup', source: 'app', companyDomain: 'acme.example' };
    assert.ok(IntentSignalSchema.safeParse(ok).success);
    assert.ok(!IntentSignalSchema.safeParse({ ...ok, eventType: 'spam' }).success, 'unknown event type');
    assert.ok(!IntentSignalSchema.safeParse({ eventType: 'signup', source: 'app' }).success, 'no way to identify the company');
    assert.ok(!IntentSignalSchema.safeParse({ ...ok, email: 'not-an-email' }).success, 'bad email');
    assert.ok(!IntentSignalSchema.safeParse({ ...ok, occurredAt: 'yesterday' }).success, 'bad timestamp');
    assert.ok(!('extra' in IntentSignalSchema.parse({ ...ok, extra: 1 })), 'unknown keys are dropped');
  });
});

describe('01 signals: webhook server', () => {
  const runtime = buildRuntime(loadConfig({}));
  let server: Server;
  let base = '';

  async function start(options: Partial<Parameters<typeof createSignalServer>[0]> = {}) {
    ({ server } = createSignalServer({ runtime, log: () => {}, ...options }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/webhooks/signal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  async function waitForJob(leadId: string) {
    for (let i = 0; i < 100; i++) {
      const job = (await (await fetch(`${base}/api/leads/${leadId}`)).json()) as { status: string; result?: Record<string, unknown>; error?: string };
      if (job.status !== 'processing') return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('job did not finish');
  }

  afterEach(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('answers 202 with a lead id and runs the pipeline in the background', async () => {
    await start();
    const res = await post({ eventType: 'contact_form', source: 'website', email: 'lena.hoffmann@northwind-data.example' });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { leadId: string; statusUrl: string };
    assert.match(body.leadId, /^lead_northwind-data_[0-9a-f]{8}$/);
    assert.equal(body.statusUrl, `/api/leads/${body.leadId}`);
    const job = await waitForJob(body.leadId);
    assert.equal(job.status, 'done');
    assert.equal(job.result!.decision, 'pass');
    assert.equal(job.result!.outcome, 'activated');
    assert.equal(job.result!.draftTo, 'lena.hoffmann@northwind-data.example');
  });

  it('holds an unknown company for review instead of failing', async () => {
    await start();
    const { leadId } = (await (await post({ eventType: 'signup', source: 'app', companyDomain: 'unknown-co.example' })).json()) as { leadId: string };
    const job = await waitForJob(leadId);
    assert.equal(job.status, 'done');
    assert.equal(job.result!.outcome, 'manual_review');
  });

  it('marks the job failed when the pipeline throws, and keeps serving', async () => {
    await start({ process: async () => { throw new Error('boom'); } });
    const { leadId } = (await (await post({ eventType: 'signup', source: 'app', companyDomain: 'acme.example' })).json()) as { leadId: string };
    const job = await waitForJob(leadId);
    assert.deepEqual([job.status, job.error], ['failed', 'boom']);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  it('rejects bad requests with the right status codes', async () => {
    await start();
    assert.equal((await post({ eventType: 'spam', source: 'x', companyDomain: 'a.example' })).status, 400);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post({ eventType: 'signup', source: 'app', email: 'x@gmail.com' })).status, 422);
    assert.equal((await fetch(`${base}/api/webhooks/signal`, { method: 'POST', body: 'x=1' })).status, 415);
    assert.equal((await post('x'.repeat(70_000))).status, 413);
    assert.equal((await fetch(`${base}/api/webhooks/signal`)).status, 405);
    assert.equal((await fetch(`${base}/api/leads/nope`)).status, 404);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  });

  it('requires the shared secret when one is configured', async () => {
    await start({ secret: 's3cret' });
    const signal = { eventType: 'signup', source: 'app', companyDomain: 'acme.example' };
    assert.equal((await post(signal)).status, 401);
    assert.equal((await post(signal, { 'x-webhook-secret': 'wrong!' })).status, 401);
    assert.equal((await post(signal, { 'x-webhook-secret': 's3cret' })).status, 202);
  });

  it('reports mode and integrations on /health', async () => {
    await start();
    const health = (await (await fetch(`${base}/health`)).json()) as { status: string; mode: string };
    assert.deepEqual([health.status, health.mode], ['ok', 'mock']);
  });
});
