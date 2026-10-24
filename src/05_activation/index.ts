import type { Icp } from '../shared/icp';
import type { Routing } from '../shared/routing';
import { ActivationResultSchema, type ActivationResult, type EmailDraft, type Lead } from '../shared/types';
import { mockCRM, type CrmAdapter } from './adapters/mockCRM';
import { mockEmail, type EmailAdapter } from './adapters/mockEmail';
import { mockNotifier, type NotifierAdapter } from './adapters/mockNotifier';
import { salesHandoffSignal } from './priority';

export { createMockCRM, type CrmAdapter } from './adapters/mockCRM';
export { createMockEmail, type EmailAdapter } from './adapters/mockEmail';
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

// Activation routing. Suppression is checked first for every lead, whatever its
// decision; a suppressed lead gets no CRM write, draft or alert. Nothing here sends
// email: a 'pass' ends at a DRAFT that needs human approval, unless a fresh hand-raise
// signal routes it straight to sales, or the batch planner (priority.ts) queued it.

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
  // Set by the batch planner when a passing lead is over the daily outreach limit.
  queuedReason?: string;
  // Which signals hand a lead to sales, and their freshness window.
  routing?: Routing;
  icp?: Icp;
  now?: () => number;
}

export async function activateLead(lead: Lead, options: ActivateOptions = {}): Promise<ActivationResult> {
  const { crm = mockCRM, email = mockEmail, notifier = mockNotifier, delivery, queuedReason, routing, icp, now = Date.now } = options;
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
    return ActivationResultSchema.parse({ ...base, outcome: 'suppressed', active: false, reason, crm: null, draft: null, alerts: [] });
  }
  log.push('Suppression check: clear');

  switch (q.decision) {
    case 'pass': {
      const handoff = salesHandoffSignal(lead, { asOfMs: activatedAt, routing, icp });
      if (handoff) {
        const reason = `Fresh ${handoff.type} signal: handed to sales for a personal reply, no sequence`;
        const crmSync = await crm.syncContact(lead);
        log.push(`CRM: ${crmSync.action} company ${crmSync.companyRecordId}, ${crmSync.contactRecordId ? `contact ${crmSync.contactRecordId}, ` : ''}deal ${crmSync.dealId}`);
        log.push(`Routed to sales: ${handoff.type} [${handoff.signal.id}]; no outreach draft`);
        const handoffStep = `Reply personally to the ${handoff.type} [${handoff.signal.id}]; this lead gets no outreach sequence`;
        const alert = await notifier.sendAlert(lead, '#hot-leads', { sentAt: activatedAt, crm: crmSync, handoff: handoffStep });
        log.push(`Slack: alert posted to ${alert.channel}`);
        return ActivationResultSchema.parse({ ...base, outcome: 'routed_to_sales', active: true, reason, crm: crmSync, draft: null, alerts: [alert] });
      }
      if (queuedReason) {
        log.push(`Queued: ${queuedReason}. No CRM sync, draft or alert yet.`);
        return ActivationResultSchema.parse({ ...base, outcome: 'queued', active: true, reason: queuedReason, crm: null, draft: null, alerts: [] });
      }
      const crmSync = await crm.syncContact(lead);
      log.push(`CRM: ${crmSync.action} company ${crmSync.companyRecordId}, ${crmSync.contactRecordId ? `contact ${crmSync.contactRecordId}, ` : ''}deal ${crmSync.dealId}`);
      const draft = await email.generateDraft(lead, { asOfMs: activatedAt });
      log.push(`Email: DRAFT "${draft.subject}" to ${draft.to ?? 'no sendable recipient'} (persona '${draft.persona}'), awaiting approval`);
      if (delivery) {
        const delivered = await delivery.deliver(draft, lead).catch(error => ({ status: 'failed' as const, detail: String(error) }));
        log.push(`Review: draft ${delivered.status === 'sent' ? 'delivered' : 'NOT delivered'} via ${delivery.name}: ${delivered.detail}`);
      }
      const alert = await notifier.sendAlert(lead, '#hot-leads', { sentAt: activatedAt, crm: crmSync, draft });
      log.push(`Slack: alert posted to ${alert.channel}`);
      return ActivationResultSchema.parse({
        ...base,
        outcome: 'activated',
        active: true,
        reason: `Passed qualification with score ${q.score}`,
        crm: crmSync,
        draft,
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
        alerts: [alert],
      });
    }
    case 'disqualify': {
      const reasons = q.evidence.filter(line => /^(Hit dealbreaker|Poor fit)/.test(line));
      const reason = (reasons.length ? reasons : q.evidence).join('; ');
      log.push(`Disqualified: ${reason}`);
      log.push('Marked inactive; no CRM sync, draft or alert.');
      return ActivationResultSchema.parse({ ...base, outcome: 'disqualified', active: false, reason, crm: null, draft: null, alerts: [] });
    }
  }
}
