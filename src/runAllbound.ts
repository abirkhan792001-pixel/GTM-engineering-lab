import { pathToFileURL } from 'node:url';
import { IntentSignalSchema, intentToLead, MOCK_ACCOUNT_LISTS, MOCK_AS_OF_MS, mergeLead, sourceAccounts, type AccountListProvider } from './01_signals/index';
import { mockScoreRubric } from './03_qualification/index';
import {
  createApprovalService,
  createMockAudiences,
  createMockCRM,
  createMockEmail,
  createMockNotifier,
  createMockSender,
  selectPostsToPromote,
  type ApprovalService,
  type FounderPost,
} from './05_activation/index';
import { attributeConversion, describeAttribution, type Attribution } from './06_learning/index';
import { processBatch, processLead, type PipelineOptions, type PipelineResult } from './runPipeline';
import type { Lead, Touch } from './shared/types';

// The allbound loop, offline, on mock data:
//   1. Source   pull accounts from five list providers and dedupe them into one lead each
//   2. Qualify  enrich, score against the ICP, find the buyer (persona fallback, email waterfall)
//   3. Run      email, LinkedIn and call steps plus ad audiences on the same people; pick the
//               founder posts to run as ads; a reviewer approves the first-touch emails
//   4. Capture  two days later someone engages (a post like and an ad click) on one account
//   5. Follow   that account gets a follow-up draft and retargeting ads; an account with no
//               new engagement waits; a booked meeting goes to sales with its attribution
// Every step writes to the same mock CRM timeline, which is where attribution comes from.

const DAY_MS = 86_400_000;

export interface AllboundRun {
  sourced: Awaited<ReturnType<typeof sourceAccounts>>;
  firstPass: PipelineResult[];
  posts: ReturnType<typeof selectPostsToPromote>;
  sentFirstTouches: string[];
  followUp: PipelineResult;
  waiting: PipelineResult;
  meeting: PipelineResult;
  attribution: Attribution;
  timeline: Touch[];
}

// Founder posts from the last two weeks, with their LinkedIn stats. Synthetic.
export function mockFounderPosts(asOfMs: number): FounderPost[] {
  const post = (id: string, daysAgo: number, impressions: number, reactions: number, comments: number, reposts: number): FounderPost => ({
    id,
    author: 'Founder',
    publishedAt: asOfMs - daysAgo * DAY_MS,
    impressions,
    reactions,
    comments,
    reposts,
  });
  return [
    post('post_scoring_breakdown', 3, 8_200, 240, 61, 12),
    post('post_hiring_signals', 6, 5_400, 98, 22, 4),
    post('post_attribution_myths', 9, 12_000, 410, 95, 30),
    post('post_team_offsite', 2, 300, 40, 6, 0),
    post('post_old_launch', 30, 20_000, 900, 120, 60),
  ];
}

// One account's engagement after the first touch, as the webhook would receive it.
function engagement(lead: Lead, at: number, events: unknown[]): Lead {
  let merged = lead;
  events.forEach((event, i) => {
    const incoming = intentToLead(IntentSignalSchema.parse(event), { now: at, id: () => `d${Math.round(at / DAY_MS)}${i}` });
    merged = mergeLead(merged, incoming, at) ?? merged;
  });
  return merged;
}

async function approveSendable(approvals: ApprovalService, results: PipelineResult[]): Promise<string[]> {
  const sent: string[] = [];
  for (const { lead, activation } of results) {
    if (!activation.draft?.to) continue;
    const record = approvals.register(lead, activation.draft);
    // The demo reviewer reads each draft, including its review notes, then approves it.
    const outcome = await approvals.approve(record.id, { approvedBy: 'demo-reviewer', contentHash: record.contentHash, acknowledgeReviewNotes: true });
    if (outcome.ok) sent.push(`${lead.companyDomain} (${outcome.record.sent!.to})`);
  }
  return sent;
}

export async function runAllbound({ lists = MOCK_ACCOUNT_LISTS, startMs = MOCK_AS_OF_MS }: { lists?: AccountListProvider[]; startMs?: number } = {}): Promise<AllboundRun> {
  let clock = startMs;
  const at = (offsetMs: number) => () => clock + offsetMs;
  const crm = createMockCRM();
  const options: PipelineOptions = {
    clocks: { enrich: at(60_000), qualify: at(120_000), contacts: at(150_000), activate: at(180_000) },
    adapters: { crm, email: createMockEmail(), notifier: createMockNotifier(), audiences: createMockAudiences() },
    qualify: { scorer: mockScoreRubric },
  };
  const approvals = createApprovalService({ sender: createMockSender(), crm, now: at(240_000) });

  // Day 0: source, qualify, plan every channel, approve the first touches.
  const sourced = await sourceAccounts(lists, { now: clock });
  const firstPass = await processBatch(sourced.leads, options);
  const posts = selectPostsToPromote(mockFounderPosts(clock), clock);
  const sentFirstTouches = await approveSendable(approvals, firstPass);

  const byDomain = new Map(firstPass.map(r => [r.lead.companyDomain, r.lead]));
  const quill = byDomain.get('quillstack.example');
  const orchard = byDomain.get('orchardops.example');
  if (!quill || !orchard) throw new Error('The mock lists must source quillstack.example and orchardops.example');

  // Day 2: Sofia at Quill Stack likes a founder post and clicks a LinkedIn ad; Orchard Ops is quiet.
  clock = startMs + 2 * DAY_MS;
  const engaged = engagement(quill, clock, [
    {
      eventType: 'linkedin_engagement',
      engagement: 'own_post',
      source: 'linkedin-post-engagers',
      companyDomain: 'quillstack.example',
      name: 'Sofia Alvarez',
      title: 'VP Marketing',
      linkedinUrl: 'https://linkedin.example/in/sofia-alvarez',
    },
    { eventType: 'ad_click', adPlatform: 'linkedin', source: 'fibbler', companyDomain: 'quillstack.example' },
  ]);
  const followUp = await processLead(engaged, options);
  if (followUp.activation.draft) await approveSendable(approvals, [followUp]);
  const waiting = await processLead(engagement(orchard, clock, [{ eventType: 'hiring', source: 'job-board', companyDomain: 'orchardops.example', metadata: { jobTitle: 'RevOps Manager' } }]), options);

  // Day 5: Sofia books a meeting. Sales takes it from here; the CRM timeline says what led to it.
  clock = startMs + 5 * DAY_MS;
  const booked = engagement(followUp.lead, clock, [{ eventType: 'meeting_booked', source: 'calendar', email: 'sofia@quillstack.example', name: 'Sofia Alvarez', title: 'VP Marketing' }]);
  const meeting = await processLead(booked, options);
  const timeline = await crm.timeline('quillstack.example');
  const attribution = attributeConversion(timeline, clock);

  return { sourced, firstPass, posts, sentFirstTouches, followUp, waiting, meeting, attribution, timeline };
}

const day = (ms: number, startMs: number) => `day ${Math.floor((ms - startMs) / DAY_MS)}`;

async function main(): Promise<void> {
  const run = await runAllbound();
  const start = MOCK_AS_OF_MS;

  console.log('=== 1. Source: five account lists, deduped by domain ===');
  for (const s of run.sourced.sources) console.log(`  ${s.source.padEnd(16)} ${s.status}, ${s.fetched} records, ${s.rejected} rejected, ${s.costInCents}¢`);
  console.log(`  -> ${run.sourced.leads.length} accounts (${run.sourced.duplicates} duplicate listings merged)`);
  for (const lead of run.sourced.leads) console.log(`     ${lead.companyDomain.padEnd(22)} listed by ${lead.signals.map(s => s.source).join(', ')}`);

  console.log('\n=== 2-3. Qualify, then run every channel on the same people ===');
  for (const { lead, activation } of run.firstPass) {
    const c = lead.contact;
    console.log(`  ${lead.companyDomain}: ${lead.qualification?.decision} (${lead.qualification?.score}) -> ${activation.outcome}`);
    if (c) console.log(`     contact: ${c.status}: ${c.reason} [${c.steps.map(s => `${s.source} ${s.status}`).join(' -> ')}]`);
    for (const step of activation.channels?.steps ?? []) console.log(`     day ${step.day} ${step.action.padEnd(18)} ${step.status === 'planned' ? `planned -> ${step.target}` : `skipped: ${step.reason}`}`);
    for (const a of activation.channels?.audiences ?? []) console.log(`     ads ${a.platform.padEnd(8)} ${a.audience.padEnd(19)} ${a.status}${a.status === 'skipped' ? `: ${a.detail.split(': ')[1]}` : ''}`);
    if (!activation.channels) console.log(`     ${activation.reason}`);
  }
  console.log('\n  Founder posts to run as ads:');
  for (const d of run.posts.promote) console.log(`     promote ${d.post.id}: ${d.reason}`);
  for (const d of run.posts.hold) console.log(`     hold    ${d.post.id}: ${d.reason}`);
  console.log(`\n  First touches approved and sent: ${run.sentFirstTouches.join(', ') || 'none'}`);

  console.log('\n=== 4-5. Capture engagement, follow up, log it all in the CRM ===');
  for (const [label, result] of [['quillstack.example after a post like and an ad click', run.followUp], ['orchardops.example with only a new job post', run.waiting], ['quillstack.example books a meeting', run.meeting]] as const) {
    console.log(`  ${label}: ${result.activation.outcome}`);
    for (const line of result.activation.log.filter(l => /^(Follow-up|Email|Channels|In sequence|Routed|Attribution)/.test(l))) console.log(`     - ${line}`);
  }

  console.log('\n  CRM timeline for quillstack.example:');
  for (const t of run.timeline) console.log(`     ${day(t.at, start)} ${t.direction.padEnd(8)} ${t.channel.padEnd(5)} ${t.kind}: ${t.detail}`);
  console.log(`\n  ${describeAttribution(run.attribution)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
