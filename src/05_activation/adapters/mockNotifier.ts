import { SlackAlertSchema, type CrmSync, type EmailDraft, type Lead, type SlackAlert, type SlackChannel } from '../../shared/types';

// Simulates Slack. Alerts are formatted for a rep to act on without opening the
// pipeline, and collected in an in-memory outbox instead of being posted.

export interface AlertContext {
  sentAt: number;
  crm?: CrmSync | null;
  draft?: EmailDraft | null;
  // Set when the lead skips outreach and goes straight to sales: what the rep should do.
  handoff?: string;
}

export interface NotifierAdapter {
  sendAlert(lead: Lead, channel: SlackChannel, context: AlertContext): Promise<SlackAlert>;
}

// Evidence lines worth showing a rep: the scored facts, not the bookkeeping lines.
function keyEvidence(lead: Lead, limit = 4): string[] {
  const lines = lead.qualification?.evidence ?? [];
  return lines.filter(line => !/^(Rubric score|Passed|Held)/.test(line)).slice(0, limit);
}

export function formatAlert(lead: Lead, channel: SlackChannel, context: AlertContext): string {
  const q = lead.qualification;
  const header = context.handoff
    ? `:raising_hand: *Hand-raiser, reply personally:* ${lead.companyDomain} (ICP score ${q?.score ?? '?'})`
    : channel === '#hot-leads'
      ? `:fire: *Hot lead:* ${lead.companyDomain} (ICP score ${q?.score ?? '?'})`
      : `:mag: *Needs review:* ${lead.companyDomain} (ICP score ${q?.score ?? '?'}, ${q?.decision ?? 'unqualified'})`;
  const lines = [header];
  if (channel === '#manual-review') {
    lines.push(`*Missing fields:* ${q?.missingFields.length ? q.missingFields.join(', ') : 'none (score below pass threshold)'}`);
  }
  lines.push('*Why:*', ...keyEvidence(lead).map(line => `• ${line}`));
  if (context.handoff) {
    const c = lead.contact;
    lines.push(
      c?.person
        ? `*Contact:* ${c.person.fullName}, ${c.person.title}${c.email ? ` <${c.email}>` : ''} (${c.status})`
        : '*Contact:* not identified; reply to whoever sent the request.',
      `*Next step:* ${context.handoff}.`,
    );
  } else if (channel === '#hot-leads') {
    const c = lead.contact;
    const person = c?.person ? `${c.person.fullName}, ${c.person.title}` : null;
    lines.push(
      context.draft?.to
        ? `*Contact:* ${person} <${context.draft.to}> (verified)`
        : `*Contact:* no sendable recipient${person ? ` (found ${person}; email ${c?.emailStatus ?? 'missing'})` : ''}. Find one before approving.`,
    );
  }
  if (context.crm) lines.push(`*CRM:* ${context.crm.url} (${context.crm.action})`);
  if (context.draft) {
    lines.push(`*Draft:* "${context.draft.subject}" (${context.draft.variantId}) awaiting approval (${context.draft.reviewNotes.length} review note(s))`);
  }
  if (channel === '#manual-review') lines.push('*Next step:* fill the missing fields or confirm fit, then re-run qualification.');
  return lines.join('\n');
}

export function createMockNotifier(): NotifierAdapter & { outbox: SlackAlert[] } {
  const outbox: SlackAlert[] = [];
  return {
    outbox,
    async sendAlert(lead, channel, context) {
      const alert = SlackAlertSchema.parse({ channel, text: formatAlert(lead, channel, context), sentAt: context.sentAt, delivery: 'mock' });
      outbox.push(alert);
      return alert;
    },
  };
}

export const mockNotifier = createMockNotifier();
