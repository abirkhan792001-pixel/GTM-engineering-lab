import { attributeConversion, describeAttribution } from '../06_learning/index';
import { CHANNELS, type ChannelsConfig } from '../shared/channels';
import type { Icp } from '../shared/icp';
import type { Routing } from '../shared/routing';
import { ActivationResultSchema, type ActivationResult, type AudienceMembership, type ChannelPlan, type EmailDraft, type Lead } from '../shared/types';
import { signalTypeOf } from '../shared/warmth';
import { mockAudiences, type AudienceAdapter } from './adapters/mockAudiences';
import { mockCRM, type CrmAdapter } from './adapters/mockCRM';
import { mockEmail, type EmailAdapter } from './adapters/mockEmail';
import { mockNotifier, type NotifierAdapter } from './adapters/mockNotifier';
import { newEngagement, planAudiences, planSteps, touchForSignal, type PlanMode } from './channels';
import { salesHandoffSignal } from './priority';

export { createMockAudiences, hashForAudience, type AudienceAdapter, type AudienceMember } from './adapters/mockAudiences';
export { createMockCRM, type CrmAdapter } from './adapters/mockCRM';
export { createMockEmail, type DraftContext, type EmailAdapter } from './adapters/mockEmail';
export { createMockNotifier, type NotifierAdapter } from './adapters/mockNotifier';
export { createLiveResend, createResendSender, reviewEmailText, type LiveResendOptions, type ResendSenderOptions } from './adapters/liveResend';
export { createMockSender } from './adapters/mockSender';
export {
  ApproveInputSchema,
  createApprovalService,
  draftContentHash,
  draftIdFor,
  DraftStatusSchema,
  RejectInputSchema,
  type ApprovalOutcome,
  type ApprovalService,
  type AuditEntry,
  type DraftRecord,
  type DraftStatus,
  type ProspectSender,
} from './approvals';
export { createLiveSlack, toBlockKit, type FetchLike, type LiveSlackOptions } from './adapters/liveSlack';
export { compareForOutreach, planOutreach, salesHandoffSignal, type OutreachLane, type OutreachSlot, type PriorityOptions } from './priority';
export { newEngagement, planAudiences, planSteps, selectPostsToPromote, touchForSignal, type AudienceIntent, type FounderPost, type PlanMode, type PostDecision } from './channels';

// Activation routing. Suppression is checked first for every lead, whatever its
// decision; a suppressed lead gets no CRM write, draft or alert. Nothing here sends
// email: a 'pass' ends at a DRAFT that needs human approval, unless a fresh hand-raise
// signal routes it straight to sales, or the batch planner (priority.ts) queued it.
//
// Allbound: every lead synced to the CRM also gets its engagement signals logged on the
// account's timeline. A passing lead gets a channel plan (channels.ts): sequence steps on
// email, LinkedIn and calls, and ad audiences, so the same people see ads and outreach.
// If we already emailed the account, the CRM timeline decides what happens next:
//   - new engagement since the last email -> a follow-up draft, plus retargeting ads
//   - nothing new                          -> in_sequence, no new draft
// A booked meeting routes the lead to sales and logs which touches led to it.

// Delivers a finished DRAFT somewhere a human can review it (e.g. a review inbox).
// Never to the prospect: sending to a prospect needs an explicit approval step.
export interface DraftDelivery {
  name: string;
  deliver(draft: EmailDraft, lead: Lead): Promise<{ status: 'sent' | 'failed'; detail: string }>;
}

export interface ActivateOptions {
  crm?: CrmAdapter;
  email?: EmailAdapter;
  notifier?: NotifierAdapter;
  // Optional: when set (live mode), each draft is also delivered for human review.
  delivery?: DraftDelivery;
  // Ad audiences the account joins (LinkedIn, Google, Meta).
  audiences?: AudienceAdapter;
  channels?: ChannelsConfig;
  // Set by the batch planner when a passing lead is over the daily outreach limit.
  queuedReason?: string;
  // Which signals hand a lead to sales, and their freshness window.
  routing?: Routing;
  icp?: Icp;
  now?: () => number;
}

export async function activateLead(lead: Lead, options: ActivateOptions = {}): Promise<ActivationResult> {
  const { crm = mockCRM, email = mockEmail, notifier = mockNotifier, audiences = mockAudiences, channels = CHANNELS, delivery, queuedReason, routing, icp, now = Date.now } = options;
  const q = lead.qualification;
  if (!q) throw new Error(`Lead ${lead.id} has no qualification; run 03_qualification before activation`);

  const activatedAt = now();
  const log: string[] = [];
  const base = { leadId: lead.id, companyDomain: lead.companyDomain, activatedAt, log };

  // Checks the account and, when 04_contacts found one, the contact's email too.
  const suppression = await crm.checkSuppression({ domain: lead.companyDomain, email: lead.contact?.email ?? null });
  if (suppression.suppressed) {
    const reason = suppression.reason ?? 'Suppressed in CRM';
    log.push(`Suppressed: ${reason}. Halted before CRM sync, drafting or alerts.`);
    return ActivationResultSchema.parse({ ...base, outcome: 'suppressed', active: false, reason, crm: null, draft: null, channels: null, alerts: [] });
  }
  log.push('Suppression check: clear');

  switch (q.decision) {
    case 'pass': {
      const handoff = salesHandoffSignal(lead, { asOfMs: activatedAt, routing, icp });
      if (handoff) {
        const reason = `Fresh ${handoff.type} signal: handed to sales for a personal reply, no sequence`;
        const crmSync = await crm.syncContact(lead);
        log.push(`CRM: ${crmSync.action} company ${crmSync.companyRecordId}, ${crmSync.contactRecordId ? `contact ${crmSync.contactRecordId}, ` : ''}deal ${crmSync.dealId}`);
        await logEngagement(crm, lead, log);
        log.push(`Routed to sales: ${handoff.type} [${handoff.signal.id}]; no outreach draft`);
        if (handoff.type === 'meeting-booked') {
          log.push(describeAttribution(attributeConversion(await crm.timeline(lead.companyDomain), handoff.signal.timestamp)));
        }
        const handoffStep = `Reply personally to the ${handoff.type} [${handoff.signal.id}]; this lead gets no outreach sequence`;
        const alert = await notifier.sendAlert(lead, '#hot-leads', { sentAt: activatedAt, crm: crmSync, handoff: handoffStep });
        log.push(`Slack: alert posted to ${alert.channel}`);
        return ActivationResultSchema.parse({ ...base, outcome: 'routed_to_sales', active: true, reason, crm: crmSync, draft: null, channels: null, alerts: [alert] });
      }
      if (queuedReason) {
        log.push(`Queued: ${queuedReason}. No CRM sync, draft or alert yet.`);
        return ActivationResultSchema.parse({ ...base, outcome: 'queued', active: true, reason: queuedReason, crm: null, draft: null, channels: null, alerts: [] });
      }
      const crmSync = await crm.syncContact(lead);
      log.push(`CRM: ${crmSync.action} company ${crmSync.companyRecordId}, ${crmSync.contactRecordId ? `contact ${crmSync.contactRecordId}, ` : ''}deal ${crmSync.dealId}`);
      await logEngagement(crm, lead, log);

      // Have we emailed this account before, and has anyone there engaged since?
      const sentEmails = (await crm.timeline(lead.companyDomain)).filter(t => t.direction === 'outbound' && t.channel === 'email');
      const lastEmail = sentEmails.at(-1);
      const engaged = lastEmail ? newEngagement(lead, lastEmail.at, activatedAt, icp) : [];
      if (lastEmail && engaged.length === 0) {
        const reason = `Already emailed ${sentEmails.length} time(s), last ${lastEmail.kind} on ${new Date(lastEmail.at).toISOString().slice(0, 10)}; no new engagement since, so no follow-up yet`;
        log.push(`In sequence: ${reason}`);
        return ActivationResultSchema.parse({ ...base, outcome: 'in_sequence', active: true, reason, crm: crmSync, draft: null, channels: null, alerts: [] });
      }
      const mode: PlanMode = lastEmail ? 'follow_up' : 'first_touch';
      if (mode === 'follow_up') log.push(`Follow-up: ${engaged.map(s => `${signalTypeOf(s)} [${s.id}]`).join(', ')} since the last email`);

      const draft = await email.generateDraft(lead, { asOfMs: activatedAt, touch: mode, touchNumber: sentEmails.length + 1 });
      log.push(`Email: DRAFT "${draft.subject}" to ${draft.to ?? 'no sendable recipient'} (persona '${draft.persona}', touch ${draft.touchNumber}), awaiting approval`);
      const plan = await runChannels(lead, mode, activatedAt, { audiences, crm, config: channels });
      log.push(`Channels: ${describePlan(plan)}`);
      if (delivery) {
        const delivered = await delivery.deliver(draft, lead).catch(error => ({ status: 'failed' as const, detail: String(error) }));
        log.push(`Review: draft ${delivered.status === 'sent' ? 'delivered' : 'NOT delivered'} via ${delivery.name}: ${delivered.detail}`);
      }
      const alert = await notifier.sendAlert(lead, '#hot-leads', { sentAt: activatedAt, crm: crmSync, draft, channels: plan });
      log.push(`Slack: alert posted to ${alert.channel}`);
      return ActivationResultSchema.parse({
        ...base,
        outcome: 'activated',
        active: true,
        reason: mode === 'follow_up' ? `Engaged after ${sentEmails.length} email(s): follow-up drafted, retargeting on` : `Passed qualification with score ${q.score}`,
        crm: crmSync,
        draft,
        channels: plan,
        alerts: [alert],
      });
    }
    case 'hold': {
      const alert = await notifier.sendAlert(lead, '#manual-review', { sentAt: activatedAt });
      log.push(`Slack: routed to ${alert.channel} (missing: ${q.missingFields.join(', ') || 'none'})`);
      return ActivationResultSchema.parse({
        ...base,
        outcome: 'manual_review',
        active: true,
        reason: q.evidence.find(line => line.startsWith('Held:')) ?? `Held with score ${q.score}`,
        crm: null,
        draft: null,
        channels: null,
        alerts: [alert],
      });
    }
    case 'disqualify': {
      const reasons = q.evidence.filter(line => /^(Hit dealbreaker|Poor fit)/.test(line));
      const reason = (reasons.length ? reasons : q.evidence).join('; ');
      log.push(`Disqualified: ${reason}`);
      log.push('Marked inactive; no CRM sync, draft or alert.');
      return ActivationResultSchema.parse({ ...base, outcome: 'disqualified', active: false, reason, crm: null, draft: null, channels: null, alerts: [] });
    }
  }
}

// Engagement signals go on the account's CRM timeline as inbound touches (idempotent by signal id).
async function logEngagement(crm: CrmAdapter, lead: Lead, log: string[]): Promise<void> {
  let logged = 0;
  for (const signal of lead.signals) {
    const touch = touchForSignal(lead, signal);
    if (touch && (await crm.logTouch(touch)) === 'logged') logged++;
  }
  if (logged) log.push(`CRM timeline: logged ${logged} engagement touch(es)`);
}

// Plans the sequence steps and puts the account in its ad audiences. Each audience the
// account newly joins is logged as an outbound ads touch. A failed upload is reported, not thrown.
async function runChannels(lead: Lead, mode: PlanMode, asOfMs: number, deps: { audiences: AudienceAdapter; crm: CrmAdapter; config: ChannelsConfig }): Promise<ChannelPlan> {
  const memberships: AudienceMembership[] = [];
  for (const intent of planAudiences(lead, mode, asOfMs, deps.config)) {
    const { platform, audience, match } = intent;
    const label = `${platform} ${audience}`;
    if (!intent.value) {
      memberships.push({ platform, audience, match, status: 'skipped', detail: `${label}: ${intent.skipReason}` });
      continue;
    }
    let status: 'added' | 'already_member';
    try {
      status = await deps.audiences.add({ platform, audience, match, value: intent.value });
    } catch (error) {
      memberships.push({ platform, audience, match, status: 'failed', detail: `${label}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    memberships.push({ platform, audience, match, status, detail: `${label} by ${match}${status === 'already_member' ? ' (already in it)' : ''}` });
    if (status === 'added') {
      await deps.crm.logTouch({
        id: `touch_ads_${platform}_${audience}_${match}_${lead.companyDomain}`,
        companyDomain: lead.companyDomain,
        at: asOfMs,
        direction: 'outbound',
        channel: 'ads',
        kind: audience === 'engager-retargeting' ? 'retargeting-audience' : 'icp-audience',
        detail: `Added to the ${platform} ${audience} audience by ${match}`,
      });
    }
  }
  return { mode, steps: planSteps(lead, mode, asOfMs, deps.config), audiences: memberships };
}

// One line for logs: what each step and audience came to.
export function describePlan(plan: ChannelPlan): string {
  const steps = plan.steps.map(s => `day ${s.day} ${s.action} ${s.status}`).join(', ');
  const ads = plan.audiences.filter(a => a.status === 'added' || a.status === 'already_member').map(a => `${a.platform} ${a.audience}`);
  return `${plan.mode.replace('_', ' ')}: ${steps}; ads: ${ads.length ? ads.join(', ') : 'none'}`;
}
