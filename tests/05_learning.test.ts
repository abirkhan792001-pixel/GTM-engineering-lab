import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockCohort } from '../src/01_signals/index';
import { assignVariant, FIRST_TOUCH_EXPERIMENT, renderTemplate, VARIANT_IDS } from '../src/05_learning/experiments';
import { createEventStore, type EngagementEventType } from '../src/05_learning/tracker';
import { processLead } from '../src/runPipeline';
import { CLOCKS, freshAdapters, idsByVariant } from './helpers';

const TS = '2026-09-27T10:00:00.000Z';
const event = (leadId: string, eventType: EngagementEventType, timestamp = TS) => ({
  leadId,
  variantId: assignVariant(leadId).id,
  eventType,
  timestamp,
});

describe('05 learning: deterministic variant assignment', () => {
  it('always gives the same lead the same variant', () => {
    for (let i = 0; i < 50; i++) assert.equal(assignVariant(`lead_${i}`).id, assignVariant(`lead_${i}`).id);
  });

  it('normalises whitespace and case in the lead id', () => {
    assert.equal(assignVariant('  LEAD_Northwind ').id, assignVariant('lead_northwind').id);
  });

  it('splits close to 50/50 over many ids', () => {
    const n = 10_000;
    let a = 0;
    for (let i = 0; i < n; i++) if (assignVariant(`acct-${i}`).id === 'variant_a_pain') a++;
    assert.ok(a / n > 0.48 && a / n < 0.52, `variant A share ${a / n}`);
  });

  it('reshuffles when the experiment id changes (a new round)', () => {
    const next = { ...FIRST_TOUCH_EXPERIMENT, id: 'first-touch-angle-002' };
    const ids = Array.from({ length: 40 }, (_, i) => `lead_${i}`);
    assert.ok(ids.some(id => assignVariant(id).id !== assignVariant(id, next).id));
  });

  it('splits the 10-lead learning cohort 5/5', () => {
    const counts = Object.fromEntries(VARIANT_IDS.map(id => [id, 0]));
    for (const lead of generateMockCohort()) counts[assignVariant(lead.id).id]!++;
    assert.deepEqual(counts, { variant_a_pain: 5, variant_b_social_proof: 5 });
  });

  it('stamps the assigned variant on every cohort draft, with a proof-review note on B only', async () => {
    const adapters = freshAdapters();
    for (const lead of generateMockCohort()) {
      const draft = (await processLead(lead, { clocks: CLOCKS, adapters })).activation.draft!;
      assert.equal(draft.variantId, assignVariant(lead.id).id);
      assert.equal(draft.reviewNotes.some(n => n.startsWith('Variant B')), draft.variantId === 'variant_b_social_proof');
      assert.ok(draft.checks.every(c => c.passed), `${lead.companyDomain}: ${JSON.stringify(draft.checks)}`);
    }
  });

  it('reports template fields it could not fill', () => {
    assert.deepEqual(renderTemplate('your {{jobTitle}} hire at {{company}}', { company: 'acme' }), { text: 'your {{jobTitle}} hire at acme', missing: ['jobTitle'] });
  });
});

describe('05 learning: event ingestion', () => {
  const ids = idsByVariant(3);
  const [a0, a1] = ids.variant_a_pain;

  it('rejects an event whose variant differs from the lead assignment', () => {
    const store = createEventStore();
    assert.throws(() => store.trackEvent({ ...event(a0!, 'sent'), variantId: 'variant_b_social_proof' }), /is assigned variant_a_pain/);
  });

  it('rejects malformed events', () => {
    const store = createEventStore();
    assert.throws(() => store.trackEvent({ ...event(a0!, 'sent'), timestamp: 'yesterday' }));
    assert.throws(() => store.trackEvent({ ...event(a0!, 'sent'), eventType: 'clicked' }));
    assert.throws(() => store.trackEvent({ ...event(a0!, 'sent'), extra: 1 }));
  });

  it('ignores exact duplicate events', () => {
    const store = createEventStore();
    assert.deepEqual(store.trackEvent(event(a0!, 'sent')), { accepted: true });
    assert.deepEqual(store.trackEvent(event(a0!, 'sent')), { accepted: false, reason: 'duplicate' });
    assert.equal(store.events.length, 1);
  });

  it('counts each event type once per lead and excludes orphan outcomes', () => {
    const store = createEventStore();
    store.trackEvent(event(a0!, 'sent'));
    store.trackEvent(event(a0!, 'opened'));
    store.trackEvent(event(a0!, 'opened', '2026-09-28T10:00:00.000Z'));
    store.trackEvent(event(a1!, 'replied')); // never sent
    const a = store.getExperimentMetrics().variants.find(v => v.variantId === 'variant_a_pain')!;
    assert.equal(a.sends, 1);
    assert.equal(a.opened, 1);
    assert.equal(a.replied, 0);
    assert.equal(a.orphanEvents, 1);
  });
});

describe('05 learning: metrics and winner selection', () => {
  const ids = idsByVariant(5);
  const A = ids.variant_a_pain;
  const B = ids.variant_b_social_proof;
  const send = (store: ReturnType<typeof createEventStore>, leads: string[]) => leads.forEach(id => store.trackEvent(event(id, 'sent')));

  it('calculates the learn:dev scenario exactly (A 3/5 replies, 1 meeting; B 1/5 replies)', () => {
    const store = createEventStore();
    send(store, [...A, ...B]);
    A.slice(0, 3).forEach(id => store.trackEvent(event(id, 'replied')));
    store.trackEvent(event(A[0]!, 'meeting_booked'));
    store.trackEvent(event(B[0]!, 'replied'));
    store.trackEvent(event(B[4]!, 'bounced'));
    const m = store.getExperimentMetrics();
    const [a, b] = m.variants;
    assert.deepEqual([a!.sends, a!.replyRate, a!.meetingRate], [5, 60, 20]);
    assert.deepEqual([b!.sends, b!.replyRate, b!.meetingRate, b!.bounced], [5, 20, 0, 1]);
    assert.equal(m.winner, 'variant_a_pain');
    assert.match(m.winnerBasis, /^meeting-booked rate/);
  });

  it('breaks a meeting-rate tie on reply rate', () => {
    const store = createEventStore();
    send(store, [A[0]!, A[1]!, B[0]!, B[1]!]);
    store.trackEvent(event(B[0]!, 'replied'));
    const m = store.getExperimentMetrics();
    assert.equal(m.winner, 'variant_b_social_proof');
    assert.match(m.winnerBasis, /^meeting rates tied; reply rate: variant_b_social_proof 50\.0% vs variant_a_pain 0\.0%/);
  });

  it('declares no winner on a full tie or when a variant has no sends', () => {
    const tie = createEventStore();
    send(tie, [A[0]!, B[0]!]);
    assert.equal(tie.getExperimentMetrics().winner, null);
    const oneSided = createEventStore();
    send(oneSided, [A[0]!]);
    assert.equal(oneSided.getExperimentMetrics().winner, null);
  });

  it('rounds rates to one decimal (1 of 3 = 33.3%)', () => {
    const store = createEventStore();
    send(store, A.slice(0, 3));
    store.trackEvent(event(A[0]!, 'replied'));
    assert.equal(store.getExperimentMetrics().variants[0]!.replyRate, 33.3);
  });

  it('flags results below the per-variant sample floor as directional', () => {
    const store = createEventStore();
    send(store, [A[0]!, B[0]!]);
    const m = store.getExperimentMetrics();
    assert.equal(m.enoughData, false);
    assert.match(m.note, /^Insufficient data: 1\/1 sends vs a minimum of 100/);
    const lowFloor = createEventStore({ ...FIRST_TOUCH_EXPERIMENT, minSendsPerVariant: 1 });
    send(lowFloor, [A[0]!, B[0]!]);
    assert.equal(lowFloor.getExperimentMetrics().enoughData, true);
  });
});
