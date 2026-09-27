import { generateMockCohort, MOCK_AS_OF_MS } from '../01_signals/index';
import { totalEnrichmentCostInCents } from '../02_enrichment/index';
import { mockScoreRubric } from '../03_qualification/index';
import { createMockCRM, createMockEmail, createMockNotifier } from '../05_activation/index';
import { processLead, type PipelineResult } from '../runPipeline';
import { FIRST_TOUCH_EXPERIMENT, VARIANT_IDS, type VariantId } from './experiments';
import { createEventStore, type EngagementEventType, type VariantMetrics } from './tracker';

// Learning runner: 10 synthetic leads through 01 -> 05, then simulated engagement.
// Sends are simulated as if each DRAFT had been approved; nothing is really sent.
// The outcome plan is injected, and the computed metrics are checked against it.

type OutcomePlan = Record<Exclude<EngagementEventType, 'sent'>, number>;

// Scripted outcomes per variant. Openers, repliers and meetings are nested subsets of
// the variant's leads (in assignment order); bounces come from the leads that did not open.
const PLAN: Record<VariantId, OutcomePlan> = {
  variant_a_pain: { opened: 4, replied: 3, meeting_booked: 1, bounced: 0 },
  variant_b_social_proof: { opened: 3, replied: 1, meeting_booked: 0, bounced: 1 },
};

const HOUR_MS = 3_600_000;
const EVENT_OFFSET_MS: Record<EngagementEventType, number> = {
  sent: 1 * HOUR_MS,
  bounced: 1 * HOUR_MS + 300_000,
  opened: 3 * HOUR_MS,
  replied: 24 * HOUR_MS,
  meeting_booked: 72 * HOUR_MS,
};
const iso = (ms: number) => new Date(ms).toISOString();

async function main(): Promise<void> {
  const experiment = FIRST_TOUCH_EXPERIMENT;
  const leads = generateMockCohort();
  const adapters = { crm: createMockCRM(), email: createMockEmail({ experiment }), notifier: createMockNotifier() };
  const clocks = {
    enrich: () => MOCK_AS_OF_MS + 60_000,
    qualify: () => MOCK_AS_OF_MS + 120_000,
    contacts: () => MOCK_AS_OF_MS + 150_000,
    activate: () => MOCK_AS_OF_MS + 180_000,
  };

  console.log(`[06_learning] experiment ${experiment.id}`);
  console.log(`  hypothesis: ${experiment.hypothesis}\n`);

  // 1. Full pipeline for every lead.
  const results: PipelineResult[] = [];
  for (const lead of leads) results.push(await processLead(lead, { clocks, adapters, qualify: { scorer: mockScoreRubric } }));
  // Only a draft addressed to a verified contact can be (simulated as) sent.
  const drafted = results.filter(r => r.activation.draft?.to);
  const spend = results.reduce((sum, r) => sum + totalEnrichmentCostInCents(r.lead), 0);
  const outcomes = results.map(r => r.activation.outcome).reduce<Record<string, number>>((acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }), {});
  console.log(`Pipeline: ${results.length} leads -> ${JSON.stringify(outcomes)}, enrichment ${spend}¢, ${drafted.length} drafts with a verified recipient\n`);

  // 2. Assignments, straight from the stamped drafts.
  console.log('Assignments:');
  const byVariant = new Map<VariantId, PipelineResult[]>(VARIANT_IDS.map(id => [id, []]));
  for (const r of drafted) {
    const draft = r.activation.draft!;
    byVariant.get(draft.variantId as VariantId)!.push(r);
    console.log(`  ${draft.to!.padEnd(38)} ${draft.variantId.padEnd(24)} "${draft.subject}"`);
  }
  const split = VARIANT_IDS.map(id => `${id} ${byVariant.get(id)!.length}`).join(' / ');
  console.log(`  split: ${split}\n`);

  // 3. Simulated sends and engagement.
  const store = createEventStore(experiment);
  const expected = new Map<VariantId, Omit<VariantMetrics, 'openRate' | 'replyRate' | 'meetingRate'>>();
  for (const [variantId, group] of byVariant) {
    const plan = PLAN[variantId];
    const n = group.length;
    const take = (count: number) => Math.min(count, n);
    const opened = take(plan.opened);
    const bounced = Math.min(plan.bounced, n - opened);
    if (bounced < plan.bounced || opened < plan.opened) console.warn(`  warning: ${variantId} has ${n} leads; plan clamped`);
    const track = (r: PipelineResult, eventType: EngagementEventType) =>
      store.trackEvent({ leadId: r.lead.id, variantId, eventType, timestamp: iso(MOCK_AS_OF_MS + EVENT_OFFSET_MS[eventType]) });

    group.forEach((r, i) => {
      track(r, 'sent');
      if (i < opened) track(r, 'opened');
      if (i < take(Math.min(plan.replied, opened))) track(r, 'replied');
      if (i < take(Math.min(plan.meeting_booked, plan.replied, opened))) track(r, 'meeting_booked');
      if (i >= n - bounced) track(r, 'bounced');
    });
    expected.set(variantId, {
      variantId,
      sends: n,
      bounced,
      opened,
      replied: Math.min(plan.replied, opened),
      meetingsBooked: Math.min(plan.meeting_booked, plan.replied, opened),
      orphanEvents: 0,
    });
  }
  console.log(`Injected ${store.events.length} engagement events (sends simulated as approved drafts)\n`);

  // 4. Performance table.
  const metrics = store.getExperimentMetrics();
  const pct = (value: number) => `${value.toFixed(1)}%`;
  const header = ['Variant', 'Sends', 'Bounced', 'Opens', 'Open %', 'Replies', 'Reply %', 'Meetings', 'Meeting %'];
  const rows = metrics.variants.map(v => [v.variantId, v.sends, v.bounced, v.opened, pct(v.openRate), v.replied, pct(v.replyRate), v.meetingsBooked, pct(v.meetingRate)].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ');
  console.log(line(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log();
  console.log(`Winner: ${metrics.winner ?? 'none'} (${metrics.winnerBasis})`);
  console.log(`Note:   ${metrics.note}\n`);

  // 5. Verification: metrics must match the injected plan exactly.
  const problems: string[] = [];
  for (const v of metrics.variants) {
    const e = expected.get(v.variantId)!;
    for (const key of ['sends', 'bounced', 'opened', 'replied', 'meetingsBooked', 'orphanEvents'] as const) {
      if (v[key] !== e[key]) problems.push(`${v.variantId}.${key}: got ${v[key]}, expected ${e[key]}`);
    }
    const rate = (count: number) => (v.sends ? Math.round((count / v.sends) * 1000) / 10 : 0);
    if (v.replyRate !== rate(e.replied)) problems.push(`${v.variantId}.replyRate: got ${v.replyRate}, expected ${rate(e.replied)}`);
    if (v.meetingRate !== rate(e.meetingsBooked)) problems.push(`${v.variantId}.meetingRate: got ${v.meetingRate}, expected ${rate(e.meetingsBooked)}`);
  }
  const counts = VARIANT_IDS.map(id => byVariant.get(id)!.length);
  console.log(`Check: assignment ${counts.join('/')} (${Math.max(...counts) - Math.min(...counts) <= 1 ? 'even' : 'uneven'})`);
  console.log(`Check: metrics vs injected plan ${problems.length === 0 ? 'ok' : 'FAILED'}`);
  for (const problem of problems) console.log(`  - ${problem}`);
  if (problems.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
