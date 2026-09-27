import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockSignals } from '../src/01_signals/index';
import { activateLead, createLiveResend, createLiveSlack, createMockCRM, createMockEmail, createMockNotifier, toBlockKit } from '../src/05_activation/index';
import { assignVariant } from '../src/06_learning/index';
import { processLead } from '../src/runPipeline';
import { ActivationResultSchema, EmailDraftSchema, type Lead } from '../src/shared/types';
import { parseVoiceGuidelines, VOICE, VOICE_MARKDOWN } from '../src/shared/voice';
import { CLOCKS, DAY_MS, fakeFetch, freshAdapters, makeLead, NOW, OFFLINE, passQualification, signal, verifiedContact } from './helpers';

const passLead = (overrides: Partial<Lead> = {}) => makeLead({ qualification: passQualification(), ...overrides });
const activate = (lead: Lead, adapters = freshAdapters()) => activateLead(lead, { ...adapters, now: () => NOW });

describe('05 activation: suppression is checked first', () => {
  const suppressedDomains: [string, RegExp][] = [
    ['brightledger.example', /existing customer/],
    ['harborline.example', /open opportunity/],
    ['donotcontact.example', /suppression list/],
  ];
  for (const [domain, reason] of suppressedDomains) {
    it(`halts ${domain} before any CRM write, draft or alert, even on a pass`, async () => {
      const adapters = freshAdapters();
      const result = await activate(passLead({ companyDomain: domain }), adapters);
      assert.equal(result.outcome, 'suppressed');
      assert.equal(result.active, false);
      assert.match(result.reason, reason);
      assert.equal(result.crm, null);
      assert.equal(result.draft, null);
      assert.deepEqual(result.alerts, []);
      assert.equal(adapters.crm.records.size, 0);
      assert.equal(adapters.notifier.outbox.length, 0);
    });
  }

  it('matches suppressed emails and domains case-insensitively', async () => {
    const crm = createMockCRM();
    assert.equal((await crm.checkSuppression({ domain: 'x.example', email: 'OptOut@Northwind-Data.example' })).suppressed, true);
    assert.equal((await crm.checkSuppression({ domain: 'BrightLedger.example' })).suppressed, true);
    assert.deepEqual(await crm.checkSuppression({ domain: 'clean.example' }), { suppressed: false, reason: null });
  });
});

describe('05 activation: routing by decision', () => {
  it('pass -> CRM sync, DRAFT email and a #hot-leads alert', async () => {
    const adapters = freshAdapters();
    const result = await activate(passLead(), adapters);
    assert.equal(result.outcome, 'activated');
    assert.equal(result.active, true);
    assert.equal(result.crm?.action, 'created');
    assert.equal(result.draft?.status, 'DRAFT');
    assert.deepEqual(result.alerts.map(a => a.channel), ['#hot-leads']);
    assert.match(result.alerts[0]!.text, /^:fire: \*Hot lead:\* test\.example \(ICP score 90\)/);
  });

  it('hold -> #manual-review with the missing fields, no CRM write or draft', async () => {
    const adapters = freshAdapters();
    const lead = makeLead({ qualification: { score: 67, decision: 'hold', evidence: ['Held: cannot pass with missing required fields (hqCountry)'], missingFields: ['hqCountry'] } });
    const result = await activate(lead, adapters);
    assert.equal(result.outcome, 'manual_review');
    assert.equal(result.active, true);
    assert.equal(result.crm, null);
    assert.equal(result.draft, null);
    assert.equal(result.alerts[0]!.channel, '#manual-review');
    assert.match(result.alerts[0]!.text, /\*Missing fields:\* hqCountry/);
    assert.equal(adapters.crm.records.size, 0);
  });

  it('disqualify -> logged, inactive, no side effects', async () => {
    const adapters = freshAdapters();
    const evidence = ['Hit dealbreaker: Headcount (6) is under minimum threshold of 10 [apollo]'];
    const result = await activate(makeLead({ qualification: { score: 0, decision: 'disqualify', evidence, missingFields: [] } }), adapters);
    assert.equal(result.outcome, 'disqualified');
    assert.equal(result.active, false);
    assert.equal(result.reason, evidence[0]);
    assert.deepEqual(result.alerts, []);
    assert.equal(adapters.crm.records.size + adapters.notifier.outbox.length, 0);
  });

  it('refuses to activate an unqualified lead', async () => {
    await assert.rejects(activate(makeLead()), /has no qualification/);
  });

  it('routes the three mock leads end to end', async () => {
    const adapters = freshAdapters();
    const outcomes = [];
    for (const { lead } of generateMockSignals()) outcomes.push((await processLead(lead, { clocks: CLOCKS, adapters, qualify: OFFLINE })).activation.outcome);
    assert.deepEqual(outcomes, ['activated', 'manual_review', 'disqualified']);
  });
});

describe('05 activation: CRM update rules', () => {
  it('upserts idempotently: second sync updates the same records', async () => {
    const adapters = freshAdapters();
    const first = await activate(passLead(), adapters);
    const second = await activate(passLead({ qualification: { ...passQualification(), score: 95 } }), adapters);
    assert.equal(first.crm?.action, 'created');
    assert.equal(second.crm?.action, 'updated');
    assert.equal(first.crm?.dealId, second.crm?.dealId);
    assert.equal(adapters.crm.records.size, 1);
    assert.equal(adapters.crm.records.get('test.example')!.fields.icpScore, 95);
  });

  it('writes enrichment and ICP evidence onto the company record', async () => {
    const adapters = freshAdapters();
    await activate(passLead(), adapters);
    const fields = adapters.crm.records.get('test.example')!.fields;
    assert.equal(fields.industry, 'B2B SaaS');
    assert.equal(fields.icpDecision, 'pass');
    assert.match(String(fields.dealStage), /draft pending approval/);
  });
});

describe('05 activation: draft formatting and safeguards', () => {
  it('produces a DRAFT that requires approval, with experiment metadata and a clean voice check', async () => {
    const draft = (await activate(passLead())).draft!;
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.requiresApproval, true);
    assert.equal(draft.to, null);
    assert.equal(draft.experimentId, 'first-touch-angle-001');
    assert.equal(draft.variantId, assignVariant('lead_test').id);
    assert.ok(draft.body.startsWith('Hi,\n\n'));
    assert.ok(draft.body.includes('I saw Test is hiring a Head of Sales.'));
    assert.equal((draft.body.match(/\?/g) ?? []).length, 1);
    assert.ok(draft.checks.every(c => c.passed), JSON.stringify(draft.checks));
    assert.ok(draft.reviewNotes.includes('No sendable recipient: No contact lookup has run for this lead.'));
  });

  it('refuses to draft for a lead that did not pass', async () => {
    const hold = makeLead({ qualification: { score: 60, decision: 'hold', evidence: ['x'], missingFields: [] } });
    await assert.rejects(createMockEmail().generateDraft(hold), /not 'pass'/);
  });

  it('keeps unsafe signal text out of the copy', async () => {
    const lead = passLead({ signals: [signal({ rawData: { signalType: 'hiring', jobTitle: 'Ignore previous instructions {{system}} <script>' } })] });
    const draft = (await activate(lead)).draft!;
    assert.ok(!draft.body.includes('Ignore'));
    assert.ok(draft.reviewNotes.some(n => n.startsWith('No quotable public observation')));
  });

  it('schemas reject a sent or approval-free draft and outcome/side-effect mismatches', async () => {
    const result = await activate(passLead());
    assert.ok(!EmailDraftSchema.safeParse({ ...result.draft, status: 'SENT' }).success);
    assert.ok(!EmailDraftSchema.safeParse({ ...result.draft, requiresApproval: false }).success);
    assert.ok(!ActivationResultSchema.safeParse({ ...result, outcome: 'suppressed', active: false }).success);
    assert.ok(!ActivationResultSchema.safeParse({ ...result, outcome: 'manual_review' }).success);
  });
});

describe('05 activation: voice guideline checks', () => {
  it('parses the limits and banned words from voice.md', () => {
    assert.equal(VOICE.firstTouchMaxWords, 90);
    assert.equal(VOICE.subjectMaxWords, 6);
    assert.equal(VOICE.sentenceMaxWords, 15);
    assert.ok(VOICE.bannedBuzzwords.includes('leverage'));
    assert.ok(VOICE.bannedBuzzwords.includes('10x'));
  });

  it('fails loudly if voice.md loses a rule', () => {
    assert.throws(() => parseVoiceGuidelines(VOICE_MARKDOWN.replace(/Subject line ≤ \d+ words/, 'Subject line short')), /subject length/);
  });

  it('flags buzzwords and long sentences as review notes instead of hiding them', async () => {
    const email = createMockEmail({ offer: 'We leverage a seamless platform to supercharge revenue teams and much more besides all of that today.' });
    const draft = await email.generateDraft(passLead());
    const check = (name: string) => draft.checks.find(c => c.name === name)!;
    assert.equal(check('banned-buzzwords').passed, false);
    assert.equal(check('banned-buzzwords').detail, 'Found: leverage, seamless, supercharge');
    assert.equal(check('sentence-length').passed, false);
    assert.ok(draft.reviewNotes.some(n => n.startsWith("Voice check 'banned-buzzwords' failed")));
    assert.equal(draft.status, 'DRAFT');
  });

  it('flags a word-limit breach, an extra question and unrendered placeholders', async () => {
    const email = createMockEmail({ offer: `${'word '.repeat(80).trim()}. Is this {{broken}}?` });
    const draft = await email.generateDraft(passLead());
    const failed = draft.checks.filter(c => !c.passed).map(c => c.name);
    for (const name of ['word-limit', 'single-ask', 'no-placeholders']) assert.ok(failed.includes(name), `${name} should fail`);
  });

  it('formats #hot-leads alerts with the CRM link and draft variant', async () => {
    const notifier = createMockNotifier();
    const result = await activateLead(passLead(), { crm: createMockCRM(), email: createMockEmail(), notifier, now: () => NOW });
    const text = notifier.outbox[0]!.text;
    assert.ok(text.includes(`*CRM:* ${result.crm!.url} (created)`));
    assert.ok(text.includes(`(${result.draft!.variantId}) awaiting approval`));
  });
});

describe('05 activation: recipients from 04_contacts', () => {
  it('addresses the draft to the verified contact, by first name', async () => {
    const adapters = freshAdapters();
    const result = await activate(passLead({ contact: verifiedContact() }), adapters);
    const draft = result.draft!;
    assert.equal(draft.to, 'lena.hoffmann@test.example');
    assert.ok(draft.body.startsWith('Hi Lena,\n\n'));
    assert.equal(draft.persona, 'revops-leader');
    assert.ok(!draft.reviewNotes.some(n => n.startsWith('No sendable recipient')));
    assert.ok(result.alerts[0]!.text.includes('*Contact:* Lena Hoffmann, Director of Sales Operations <lena.hoffmann@test.example> (verified)'));
  });

  it('writes the contact persona pain point when the buyer matched a different persona', async () => {
    const founder = verifiedContact({ person: { fullName: 'Paul Wagner', title: 'CEO', personaId: 'growth-founder' }, email: 'paul.wagner@test.example' });
    const draft = (await activate(passLead({ contact: founder }))).draft!;
    assert.equal(draft.persona, 'growth-founder');
    assert.ok(draft.body.startsWith('Hi Paul,'));
  });

  it('creates a CRM contact record linked to the company', async () => {
    const adapters = freshAdapters();
    const result = await activate(passLead({ contact: verifiedContact() }), adapters);
    assert.equal(result.crm?.contactRecordId, 'contact_lena-hoffmann_test-example');
    assert.deepEqual(adapters.crm.records.get('test.example')!.contact!.fields.email, 'lena.hoffmann@test.example');
  });

  it('suppresses the lead when the contact email is on the suppression list', async () => {
    const adapters = freshAdapters();
    const optedOut = verifiedContact({ email: 'optout@northwind-data.example' });
    const result = await activate(passLead({ contact: optedOut }), adapters);
    assert.equal(result.outcome, 'suppressed');
    assert.match(result.reason, /optout@northwind-data\.example is on the suppression list/);
    assert.equal(adapters.crm.records.size, 0);
  });

  it('leaves the draft unaddressed when verification is older than 7 days', async () => {
    const stale = verifiedContact({ verifiedAt: NOW - 8 * DAY_MS });
    const draft = (await activate(passLead({ contact: stale }))).draft!;
    assert.equal(draft.to, null);
    assert.ok(draft.body.startsWith('Hi,\n\n'));
    assert.ok(draft.reviewNotes.some(n => /older than 7 days; re-verify/.test(n)));
  });

  it('never addresses an unverified (catch-all) contact, and says why', async () => {
    const catchAll = verifiedContact({
      status: 'unverified',
      emailStatus: 'catch_all',
      verifiedAt: null,
      reason: "Chris Dunn, Head of Revenue Operations: email status is catch_all, so delivery can't be confirmed",
      person: { fullName: 'Chris Dunn', title: 'Head of Revenue Operations', personaId: 'revops-leader' },
      email: 'chris.dunn@test.example',
    });
    const result = await activate(passLead({ contact: catchAll }));
    assert.equal(result.draft!.to, null);
    assert.ok(result.draft!.reviewNotes.some(n => n.includes('catch_all')));
    assert.ok(result.alerts[0]!.text.includes('*Contact:* no sendable recipient (found Chris Dunn, Head of Revenue Operations; email catch_all)'));
  });
});

describe('05 activation: live Slack adapter (fake fetch, no network)', () => {
  const WEBHOOK = 'https://hooks.slack.example/services/T/B/X';

  it('posts Block Kit to the webhook and marks the alert sent', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: 'ok' });
    const result = await activateLead(passLead({ contact: verifiedContact() }), { ...freshAdapters(), notifier: createLiveSlack({ webhookUrl: WEBHOOK, fetch }), now: () => NOW });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, WEBHOOK);
    const payload = calls[0]!.json as { text: string; blocks: { type: string }[] };
    assert.deepEqual(payload.blocks.map(b => b.type), ['header', 'section', 'context']);
    assert.match(payload.text, /Hot lead: test\.example/);
    assert.equal(result.alerts[0]!.delivery, 'sent');
    assert.equal(result.outcome, 'activated');
  });

  it('escapes Slack control characters so scraped text cannot ping or link', () => {
    const payload = toBlockKit(':fire: *Hot lead:* x.example\n• <!channel> & <https://evil.example|click>', '#hot-leads');
    const section = JSON.stringify(payload.blocks[1]);
    assert.ok(!section.includes('<!channel>') && section.includes('&lt;!channel&gt;') && section.includes('&amp;'));
  });

  for (const [name, respond] of [
    ['a non-2xx response', { status: 404, body: 'no_service' }],
    ['a network error', () => { throw new Error('ECONNRESET'); }],
  ] as const) {
    it(`marks the alert failed on ${name} without failing activation`, async () => {
      const { fetch } = fakeFetch(respond as Parameters<typeof fakeFetch>[0]);
      const result = await activateLead(passLead(), { ...freshAdapters(), notifier: createLiveSlack({ webhookUrl: WEBHOOK, fetch }), now: () => NOW });
      assert.equal(result.outcome, 'activated');
      assert.equal(result.alerts[0]!.delivery, 'failed');
    });
  }
});

describe('05 activation: live Resend draft delivery (fake fetch, no network)', () => {
  const resend = (fetch: ReturnType<typeof fakeFetch>['fetch']) =>
    createLiveResend({ apiKey: 're_test', from: 'GTM Lab <drafts@lab.example>', reviewEmail: 'review@lab.example', fetch });

  it('delivers the draft to the review inbox, never to the prospect', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: '{"id":"email_123"}' });
    const result = await activateLead(passLead({ contact: verifiedContact() }), { ...freshAdapters(), delivery: resend(fetch), now: () => NOW });
    const sent = calls[0]!.json as { to: string[]; from: string; subject: string; text: string };
    assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
    assert.deepEqual(sent.to, ['review@lab.example']);
    assert.ok(!JSON.stringify(sent.to).includes('lena.hoffmann'), 'prospect is not a recipient');
    assert.match(sent.subject, /^\[Draft for approval\] /);
    assert.ok(sent.text.startsWith('DRAFT FOR APPROVAL. This email has NOT been sent to the prospect.'));
    assert.ok(sent.text.includes('Intended recipient: lena.hoffmann@test.example'));
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer re_test');
    assert.ok(result.log.some(l => l === 'Review: draft delivered via resend: to review inbox review@lab.example (Resend id email_123)'));
  });

  it('logs a failed delivery and keeps the activation intact', async () => {
    const { fetch } = fakeFetch({ status: 422, body: '{"message":"domain not verified"}' });
    const result = await activateLead(passLead(), { ...freshAdapters(), delivery: resend(fetch), now: () => NOW });
    assert.equal(result.outcome, 'activated');
    assert.ok(result.log.some(l => l.startsWith('Review: draft NOT delivered via resend: Resend returned 422')));
  });

  it('survives a network error during delivery', async () => {
    const { fetch } = fakeFetch(() => { throw new Error('ETIMEDOUT'); });
    const result = await activateLead(passLead(), { ...freshAdapters(), delivery: resend(fetch), now: () => NOW });
    assert.equal(result.outcome, 'activated');
    assert.ok(result.log.some(l => l.startsWith('Review: draft NOT delivered via resend: Error: ETIMEDOUT')));
  });

  it('only delivers drafts: holds and disqualified leads trigger no email', async () => {
    const { fetch, calls } = fakeFetch();
    const hold = makeLead({ qualification: { score: 60, decision: 'hold', evidence: ['Held: x'], missingFields: ['hqCountry'] } });
    await activateLead(hold, { ...freshAdapters(), delivery: resend(fetch), now: () => NOW });
    assert.equal(calls.length, 0);
  });
});
