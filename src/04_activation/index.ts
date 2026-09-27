import { ActivationResultSchema, type ActivationResult, type Lead } from '../shared/types';
import { mockCRM, type CrmAdapter } from './adapters/mockCRM';
import { mockEmail, type EmailAdapter } from './adapters/mockEmail';
import { mockNotifier, type NotifierAdapter } from './adapters/mockNotifier';

export { createMockCRM, type CrmAdapter } from './adapters/mockCRM';
export { createMockEmail, type EmailAdapter } from './adapters/mockEmail';
export { createMockNotifier, type NotifierAdapter } from './adapters/mockNotifier';

// Activation routing. Suppression is checked first for every lead, whatever its
// decision; a suppressed lead gets no CRM write, draft or alert. Nothing here sends
// email: a 'pass' ends at a DRAFT that needs human approval.

export interface ActivateOptions {
  crm?: CrmAdapter;
  email?: EmailAdapter;
  notifier?: NotifierAdapter;
  now?: () => number;
}

export async function activateLead(lead: Lead, options: ActivateOptions = {}): Promise<ActivationResult> {
  const { crm = mockCRM, email = mockEmail, notifier = mockNotifier, now = Date.now } = options;
  const q = lead.qualification;
  if (!q) throw new Error(`Lead ${lead.id} has no qualification; run 03_qualification before activation`);

  const activatedAt = now();
  const log: string[] = [];
  const base = { leadId: lead.id, companyDomain: lead.companyDomain, activatedAt, log };

  const suppression = await crm.checkSuppression({ domain: lead.companyDomain });
  if (suppression.suppressed) {
    const reason = suppression.reason ?? 'Suppressed in CRM';
    log.push(`Suppressed: ${reason}. Halted before CRM sync, drafting or alerts.`);
    return ActivationResultSchema.parse({ ...base, outcome: 'suppressed', active: false, reason, crm: null, draft: null, alerts: [] });
  }
  log.push('Suppression check: clear');

  switch (q.decision) {
    case 'pass': {
      const crmSync = await crm.syncContact(lead);
      log.push(`CRM: ${crmSync.action} company ${crmSync.companyRecordId} and deal ${crmSync.dealId}`);
      const draft = await email.generateDraft(lead);
      log.push(`Email: DRAFT "${draft.subject}" created for persona '${draft.persona}', awaiting approval`);
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
