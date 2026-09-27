import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockSignals } from '../src/01_signals/index';
import { processLead } from '../src/runPipeline';
import { buildRuntime } from '../src/runtime';
import { loadConfig } from '../src/shared/config';
import { CLOCKS, fakeFetch, fakeFirecrawl, fakeOllama } from './helpers';

// Config parsing, and how MOCK_MODE plus the available credentials pick each integration.
// Every live adapter here uses an injected fake: no test reaches a real API.

const LIVE_KEYS = {
  MOCK_MODE: 'false',
  FIRECRAWL_API_KEY: 'fc-test',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.example/services/T/B/X',
  RESEND_API_KEY: 're_test',
  RESEND_FROM: 'GTM Lab <drafts@lab.example>',
  DRAFT_REVIEW_EMAIL: 'review@lab.example',
};

describe('config', () => {
  it('defaults to MOCK_MODE=true with no credentials', () => {
    assert.deepEqual(loadConfig({}), { MOCK_MODE: true, PORT: 3000 });
  });

  it('parses booleans and treats empty strings as unset', () => {
    const config = loadConfig({ MOCK_MODE: 'FALSE', SLACK_WEBHOOK_URL: '', FIRECRAWL_API_KEY: '  ', PORT: '8080' });
    assert.equal(config.MOCK_MODE, false);
    assert.equal(config.SLACK_WEBHOOK_URL, undefined);
    assert.equal(config.FIRECRAWL_API_KEY, undefined);
    assert.equal(config.PORT, 8080);
  });

  for (const [name, env] of [
    ['a misspelt MOCK_MODE', { MOCK_MODE: 'flase' }],
    ['a malformed Slack URL', { SLACK_WEBHOOK_URL: 'not a url' }],
    ['a malformed Ollama URL', { OLLAMA_BASE_URL: 'localhost 11434' }],
    ['a malformed review email', { DRAFT_REVIEW_EMAIL: 'nope' }],
    ['an out-of-range port', { PORT: '70000' }],
    ['a short approval token', { APPROVAL_TOKEN: 'short' }],
  ] as const) {
    it(`fails loudly on ${name}`, () => {
      assert.throws(() => loadConfig(env), /Invalid configuration/);
    });
  }
});

describe('runtime: choosing mock or live integrations', () => {
  it('stays fully mock when MOCK_MODE=true, even with credentials set', () => {
    const runtime = buildRuntime(loadConfig({ ...LIVE_KEYS, MOCK_MODE: 'true' }));
    assert.equal(runtime.mode, 'mock');
    assert.equal(runtime.pipeline.enrich, undefined);
    assert.equal(runtime.pipeline.adapters!.delivery, undefined);
    assert.deepEqual(Object.values(runtime.integrations).filter(v => v.includes('live')), []);
    assert.match(runtime.warnings[0]!, /MOCK_MODE=true: ignoring configured credentials \(FIRECRAWL_API_KEY, SLACK_WEBHOOK_URL, RESEND_API_KEY\)/);
  });

  it('falls back to every mock, with a warning each, when MOCK_MODE=false has no keys', () => {
    const runtime = buildRuntime(loadConfig({ MOCK_MODE: 'false' }));
    assert.equal(runtime.mode, 'live');
    assert.equal(runtime.integrations.enrichment, 'mock (apollo, firecrawl)');
    assert.equal(runtime.integrations.qualification, 'offline scorer');
    assert.equal(runtime.integrations.slack, 'mock');
    assert.equal(runtime.integrations.draftReview, 'off');
    for (const key of ['FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY', 'SLACK_WEBHOOK_URL', 'RESEND_API_KEY']) {
      assert.ok(runtime.warnings.some(w => w.includes(key)), `warning for ${key}`);
    }
  });

  it('needs all three Resend settings before delivering drafts', () => {
    const runtime = buildRuntime(loadConfig({ MOCK_MODE: 'false', RESEND_API_KEY: 're_test' }));
    assert.equal(runtime.pipeline.adapters!.delivery, undefined);
    assert.ok(runtime.warnings.some(w => w.startsWith('RESEND_FROM, DRAFT_REVIEW_EMAIL not set')));
  });

  it('upgrades each integration whose credentials are present', () => {
    const runtime = buildRuntime(loadConfig(LIVE_KEYS));
    assert.equal(runtime.integrations.enrichment, 'apollo (mock) -> firecrawl (live)');
    assert.equal(runtime.integrations.slack, 'live (incoming webhook)');
    assert.equal(runtime.integrations.draftReview, 'live (resend, to review@lab.example)');
    assert.equal(runtime.integrations.qualification, 'offline scorer', 'no ANTHROPIC_API_KEY in this config');
  });

  it('sends approved drafts through Resend only when live with RESEND_API_KEY and RESEND_FROM', () => {
    assert.equal(buildRuntime(loadConfig({ ...LIVE_KEYS, MOCK_MODE: 'true' })).sender.name, 'mock');
    assert.equal(buildRuntime(loadConfig(LIVE_KEYS)).sender.name, 'resend');
    const noFrom = buildRuntime(loadConfig({ MOCK_MODE: 'false', RESEND_API_KEY: 're_test' }));
    assert.equal(noFrom.sender.name, 'mock');
    assert.ok(noFrom.warnings.some(w => w.includes('approvals will use the mock outbox')));
  });

  it('warns that approvals are disabled in live mode without APPROVAL_TOKEN', () => {
    assert.ok(buildRuntime(loadConfig({ MOCK_MODE: 'false' })).warnings.some(w => w.startsWith('APPROVAL_TOKEN is not set')));
    assert.ok(!buildRuntime(loadConfig({ MOCK_MODE: 'false', APPROVAL_TOKEN: 'x'.repeat(16) })).warnings.some(w => w.startsWith('APPROVAL_TOKEN')));
  });

  it('shares one CRM between the pipeline and the approval step', () => {
    const runtime = buildRuntime(loadConfig({}));
    assert.equal(runtime.pipeline.adapters!.crm, runtime.crm);
  });

  it('scores with a local model when OLLAMA_MODEL is set, and prefers it over Claude', () => {
    const local = buildRuntime(loadConfig({ MOCK_MODE: 'false', OLLAMA_MODEL: 'llama3.2' }));
    assert.equal(local.integrations.qualification, 'local model (ollama: llama3.2)');
    assert.equal(local.pipeline.qualify!.model, 'llama3.2');
    assert.ok(!local.warnings.some(w => w.includes('offline scorer')));

    const both = buildRuntime(loadConfig({ MOCK_MODE: 'false', OLLAMA_MODEL: 'llama3.2', ANTHROPIC_API_KEY: 'sk-test' }));
    assert.equal(both.integrations.qualification, 'local model (ollama: llama3.2)');
    assert.ok(both.warnings.some(w => w.includes('ANTHROPIC_API_KEY is not used')));

    const mock = buildRuntime(loadConfig({ MOCK_MODE: 'true', OLLAMA_MODEL: 'llama3.2' }));
    assert.equal(mock.integrations.qualification, 'offline scorer');
    assert.match(mock.warnings[0]!, /ignoring configured credentials \(OLLAMA_MODEL\)/);
  });

  it('flags CRM keys as not yet used, rather than silently ignoring them', () => {
    const runtime = buildRuntime(loadConfig({ MOCK_MODE: 'false', HUBSPOT_API_KEY: 'hs-test' }));
    assert.ok(runtime.warnings.some(w => w.includes('CRM adapter is still a mock')));
  });
});

describe('runtime: end-to-end pipeline runs', () => {
  const mockLeads = () => generateMockSignals().map(s => s.lead);

  it('runs all three mock leads in live mode with no keys, without crashing', async () => {
    const runtime = buildRuntime(loadConfig({ MOCK_MODE: 'false' }));
    const outcomes = [];
    for (const lead of mockLeads()) outcomes.push((await processLead(lead, { ...runtime.pipeline, clocks: CLOCKS })).activation.outcome);
    assert.deepEqual(outcomes, ['activated', 'manual_review', 'disqualified']);
  });

  it('uses the live adapters when keys are set (fakes stand in for the APIs)', async () => {
    const firecrawl = fakeFirecrawl({ industry: 'Developer Tools', headcount: 45, hqCountry: 'NL', businessModel: 'B2B', techStack: [] });
    const http = fakeFetch({ status: 200, body: '{"id":"email_1"}' });
    const runtime = buildRuntime(loadConfig(LIVE_KEYS), { firecrawlClient: firecrawl.client, fetch: http.fetch });

    const [northwind, quietpeak] = mockLeads();
    const q = await processLead(quietpeak!, { ...runtime.pipeline, clocks: CLOCKS });
    assert.equal(firecrawl.calls[0]!.url, 'https://quietpeak.example/', 'Apollo missed, so live Firecrawl ran');
    assert.equal(q.lead.qualification!.decision, 'pass', 'the live scrape found the missing HQ country');

    const n = await processLead(northwind!, { ...runtime.pipeline, clocks: CLOCKS });
    const targets = http.calls.map(c => c.url);
    assert.ok(targets.includes('https://hooks.slack.example/services/T/B/X'), 'Slack webhook called');
    assert.ok(targets.includes('https://api.resend.com/emails'), 'draft sent to the review inbox');
    assert.equal(n.activation.alerts[0]!.delivery, 'sent');
  });

  it('qualifies with the local model end to end (a fake stands in for Ollama)', async () => {
    const ollama = fakeOllama({ content: { score: 96, decision: 'pass', evidence: ['Target industry and size, fresh hiring signal'], missingFields: [] } });
    const runtime = buildRuntime(loadConfig({ MOCK_MODE: 'false', OLLAMA_MODEL: 'llama3.2', OLLAMA_BASE_URL: 'http://gpu-box:11434' }), { ollamaFetch: ollama.fetch });
    const [northwind] = mockLeads();
    const result = await processLead(northwind!, { ...runtime.pipeline, clocks: CLOCKS });
    assert.equal(ollama.calls[0]!.url, 'http://gpu-box:11434/api/chat');
    assert.equal(result.lead.qualification!.evidence[0], 'Scored by llama3.2 against rubric icp-v2');
    assert.equal(result.activation.outcome, 'activated');
  });

  it('keeps going when every live API fails', async () => {
    const firecrawl = fakeFirecrawl(() => { throw new Error('503'); });
    const http = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
    const runtime = buildRuntime(loadConfig(LIVE_KEYS), { firecrawlClient: firecrawl.client, fetch: http.fetch });
    const outcomes = [];
    for (const lead of mockLeads()) {
      const result = await processLead(lead, { ...runtime.pipeline, clocks: CLOCKS });
      outcomes.push(result.activation.outcome);
      for (const alert of result.activation.alerts) assert.equal(alert.delivery, 'failed');
    }
    assert.deepEqual(outcomes, ['activated', 'manual_review', 'disqualified']);
  });
});
