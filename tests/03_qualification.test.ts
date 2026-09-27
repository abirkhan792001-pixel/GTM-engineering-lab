import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { generateMockSignals } from '../src/01_signals/index';
import { enrichLead } from '../src/02_enrichment/index';
import {
  checkHardGates,
  createOllamaClient,
  decide,
  DEFAULT_QUALIFIER_MODEL,
  evaluateICP,
  mockScoreRubric,
  qualifyLead,
  type ClaudeClient,
} from '../src/03_qualification/index';
import { ICP, IcpSchema } from '../src/shared/icp';
import type { Lead, Qualification } from '../src/shared/types';
import { CLOCKS, enriched, fakeOllama, makeLead, NOW, OFFLINE, signal, TARGET_FIRMOGRAPHICS } from './helpers';

async function qualifyMock(index: number): Promise<Qualification> {
  const lead = generateMockSignals()[index]!.lead;
  const q = (await qualifyLead(await enrichLead(lead, { now: CLOCKS.enrich }), { now: CLOCKS.qualify, ...OFFLINE })).qualification;
  assert.ok(q);
  return q;
}

const qualify = async (lead: Lead) => (await qualifyLead(lead, { now: () => NOW, ...OFFLINE })).qualification!;
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

// ---------------------------------------------------------------------------
// Claude evaluator. Every test injects a fake client: no network, no API credits.
// ---------------------------------------------------------------------------

type ParseParams = Parameters<ClaudeClient['messages']['parse']>[0];

function fakeClaude(respond: (params: ParseParams) => unknown) {
  const calls: ParseParams[] = [];
  const client = {
    messages: {
      parse: async (params: ParseParams) => {
        calls.push(params);
        return respond(params);
      },
    },
  } as unknown as ClaudeClient;
  return { client, calls };
}

const reply = (parsed_output: unknown, stop_reason = 'end_turn') => () => ({ stop_reason, parsed_output, content: [] });
const enrichedMock = (index: number) => enrichLead(generateMockSignals()[index]!.lead, { now: CLOCKS.enrich });
const qualifyWith = async (lead: Lead, client: ClaudeClient) => (await qualifyLead(lead, { now: CLOCKS.qualify, client })).qualification!;

const NORTHWIND_OUTPUT = {
  score: 97,
  decision: 'pass',
  evidence: ["Industry 'B2B SaaS' is a target industry (+30) [apollo]", 'Fresh hiring signal, 2.0 days old (+27) [sig_northwind_hiring_001]'],
  missingFields: [],
};

describe('03 qualification: Claude evaluator (mocked API)', () => {
  it('uses the structured output when it is valid and consistent with policy', async () => {
    const { client, calls } = fakeClaude(reply(NORTHWIND_OUTPUT));
    const q = await qualifyWith(await enrichedMock(0), client);
    assert.equal(calls.length, 1);
    assert.equal(q.decision, 'pass');
    assert.equal(q.score, 97);
    assert.equal(q.evidence[0], `Scored by ${DEFAULT_QUALIFIER_MODEL} against rubric ${ICP.version}`);
    assert.ok(q.evidence.includes(NORTHWIND_OUTPUT.evidence[0]!));
    assert.ok(!q.evidence.some(e => e.startsWith('Model recommended')), 'no disagreement note when model and policy agree');
  });

  it('sends the model, rubric, lead context and signal history with a JSON schema output format', async () => {
    const { client, calls } = fakeClaude(reply(NORTHWIND_OUTPUT));
    await qualifyWith(await enrichedMock(0), client);
    const params = calls[0]!;
    assert.equal(params.model, 'claude-sonnet-5');
    assert.equal(params.output_config?.format?.type, 'json_schema');
    assert.equal(params.output_config?.effort, 'medium');
    const system = String(params.system);
    assert.ok(system.includes('"passThreshold": 70') && system.includes('"requiredFields"'), 'icp.json rules in the system prompt');
    assert.ok(system.includes('untrusted'), 'untrusted-input instruction present');
    const user = String(params.messages[0]!.content);
    assert.ok(user.includes('"companyDomain": "northwind-data.example"'));
    assert.ok(user.includes('"source": "apollo"'), 'verified enrichment carries its source');
    assert.ok(user.includes('"id": "sig_northwind_hiring_001"') && user.includes('"ageDays": 2'), 'signal history with ages');
    assert.ok(user.includes('"id": "sig_northwind_pricing_002"'));
  });

  it('honours an explicit model option', async () => {
    const { client, calls } = fakeClaude(reply(NORTHWIND_OUTPUT));
    await qualifyLead(await enrichedMock(0), { now: CLOCKS.qualify, client, model: 'claude-opus-5' });
    assert.equal(calls[0]!.model, 'claude-opus-5');
  });

  it('never calls the API for a lead the hard gates disqualify', async () => {
    const { client, calls } = fakeClaude(reply(NORTHWIND_OUTPUT));
    const q = await qualifyWith(await enrichedMock(2), client);
    assert.equal(calls.length, 0);
    assert.equal(q.decision, 'disqualify');
  });

  it('holds a model "pass" when enrichment is missing a required field the model ignored', async () => {
    const { client } = fakeClaude(reply({ score: 95, decision: 'pass', evidence: ['Looks great'], missingFields: [] }));
    const q = await qualifyWith(await enrichedMock(1), client);
    assert.equal(q.decision, 'hold');
    assert.deepEqual(q.missingFields, ['hqCountry']);
    assert.ok(q.evidence.includes("Model recommended 'pass'; policy applied 'hold'"));
  });

  it('holds a model "pass" whose score is below the pass threshold', async () => {
    const { client } = fakeClaude(reply({ score: 60, decision: 'pass', evidence: ['Partial fit'], missingFields: [] }));
    const q = await qualifyWith(await enrichedMock(0), client);
    assert.equal(q.decision, 'hold');
    assert.equal(q.score, 60);
  });

  it('keeps non-required unknowns as a note without blocking a pass', async () => {
    const { client } = fakeClaude(reply({ ...NORTHWIND_OUTPUT, missingFields: ['techStack'] }));
    const q = await qualifyWith(await enrichedMock(0), client);
    assert.equal(q.decision, 'pass');
    assert.deepEqual(q.missingFields, []);
    assert.ok(q.evidence.includes('Model also noted unknown: techStack'));
  });
});

describe('03 qualification: Claude evaluator safe fallbacks', () => {
  const cases: [string, () => unknown, RegExp][] = [
    ['a network failure', () => { throw new Anthropic.APIConnectionError({ message: 'socket hang up' }); }, /could not reach the API/],
    ['an invalid API key', () => { throw new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()); }, /authentication failed/],
    ['rate limiting', () => { throw new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers()); }, /rate limited/],
    ['malformed JSON from the model', () => { throw new Anthropic.AnthropicError('Failed to parse structured output as JSON'); }, /malformed model output/],
    ['a refusal', reply(null, 'refusal'), /declined/],
    ['truncation at max_tokens', reply(null, 'max_tokens'), /truncated/],
    ['a response with no structured output', reply(null), /no structured output/],
    ['empty evidence', reply({ score: 90, decision: 'pass', evidence: [], missingFields: [] }), /violates QualificationSchema/],
    ['disqualify with a non-zero score', reply({ score: 30, decision: 'disqualify', evidence: ['x'], missingFields: [] }), /violates QualificationSchema/],
  ];
  for (const [name, respond, reason] of cases) {
    it(`falls back to a safe hold on ${name}`, async () => {
      const { client } = fakeClaude(respond);
      const q = await qualifyWith(await enrichedMock(1), client);
      assert.equal(q.decision, 'hold');
      assert.equal(q.score, 0);
      assert.match(q.evidence[0]!, /^LLM evaluation unavailable \(/);
      assert.match(q.evidence[0]!, reason);
      assert.deepEqual(q.missingFields, ['hqCountry'], 'deterministic missing fields still reported');
    });
  }

  it('never reaches the network from the test suite, even on the default client path', async () => {
    const started = Date.now();
    const q = (await qualifyLead(await enrichedMock(0), { now: CLOCKS.qualify })).qualification!;
    assert.equal(q.decision, 'hold');
    assert.match(q.evidence[0]!, /could not reach the API/);
    assert.ok(Date.now() - started < 30_000);
  });
});

// ---------------------------------------------------------------------------
// Local model via Ollama: a drop-in `client`, so the same prompt, schema and policy apply.
// Every test injects a fake /api/chat endpoint: no Ollama server is needed.
// ---------------------------------------------------------------------------

describe('03 qualification: local model evaluator (Ollama)', () => {
  const local = (respond: Parameters<typeof fakeOllama>[0]) => {
    const ollama = fakeOllama(respond);
    return { client: createOllamaClient({ baseUrl: 'http://ollama.test:11434/', fetch: ollama.fetch }), calls: ollama.calls };
  };
  const qualifyLocal = async (lead: Lead, client: ClaudeClient) => (await qualifyLead(lead, { now: CLOCKS.qualify, client, model: 'llama3.2' })).qualification!;

  it('sends the rubric, the lead and the output schema to /api/chat', async () => {
    const { client, calls } = local({ content: NORTHWIND_OUTPUT });
    await qualifyLocal(await enrichedMock(0), client);
    assert.equal(calls.length, 1);
    const { url, body } = calls[0]!;
    assert.equal(url, 'http://ollama.test:11434/api/chat', 'trailing slash on the base URL is dropped');
    assert.equal(body.model, 'llama3.2');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
    assert.match(body.messages[0].content, /ideal customer profile/);
    assert.match(body.messages[1].content, /northwind-data\.example/);
    assert.deepEqual(body.format.required, ['score', 'decision', 'evidence', 'missingFields']);
    assert.deepEqual(body.format.properties.decision.enum, ['pass', 'hold', 'disqualify']);
  });

  it('passes a lead through the same policy as Claude, labelled with the local model', async () => {
    const { client } = local({ content: NORTHWIND_OUTPUT });
    const q = await qualifyLocal(await enrichedMock(0), client);
    assert.equal(q.decision, 'pass');
    assert.equal(q.score, 97);
    assert.equal(q.evidence[0], `Scored by llama3.2 against rubric ${ICP.version}`);
  });

  it('cannot pass a lead the thresholds would hold, whatever the model says', async () => {
    const { client } = local({ content: { score: 60, decision: 'pass', evidence: ['Partial fit'], missingFields: [] } });
    const q = await qualifyLocal(makeLead(), client);
    assert.equal(q.decision, 'hold');
    assert.ok(q.evidence.includes("Model recommended 'pass'; policy applied 'hold'"));
  });

  const failures: [string, Parameters<typeof fakeOllama>[0], RegExp][] = [
    ['Ollama not running', () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }, /could not reach Ollama at http:\/\/ollama\.test:11434 \(is it running\?\)/],
    ['a model that is not pulled', { status: 404, content: '{"error":"model \'llama3.2\' not found"}' }, /Ollama returned 404: .*not found/],
    ['a reply that is not JSON', { content: 'Sure! Here is my assessment...' }, /no structured output/],
    ['JSON that breaks the schema', { content: { score: 90, decision: 'pass', evidence: [], missingFields: [] } }, /violates QualificationSchema/],
  ];
  for (const [name, respond, reason] of failures) {
    it(`falls back to a safe hold on ${name}`, async () => {
      const { client } = local(respond);
      const q = await qualifyLocal(await enrichedMock(1), client);
      assert.equal(q.decision, 'hold');
      assert.equal(q.score, 0);
      assert.match(q.evidence[0]!, /^LLM evaluation unavailable \(/);
      assert.match(q.evidence[0]!, reason);
    });
  }
});
