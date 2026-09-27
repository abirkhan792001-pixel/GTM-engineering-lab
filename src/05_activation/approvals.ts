import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sendableEmail } from '../04_contacts/index';
import type { EmailDraft, Lead } from '../shared/types';
import type { CrmAdapter } from './adapters/mockCRM';

// Human approval before any email reaches a prospect.
//
// Every draft the pipeline produces is registered here as 'pending_approval'. A named
// reviewer approves the exact content they read (by its content hash) or rejects it.
// Approval re-runs the send-time checks, fail-closed, immediately before sending:
//   - the recipient is still the verified contact, verified within the last 7 days
//   - neither the recipient nor the account has been suppressed since the draft was made
//   - the draft is still pending (so a double click can't send twice)
// Every transition is appended to the record's audit history.
//
// Records live in memory (bounded); a database-backed store can implement the same service.

export const DraftStatusSchema = z.enum(['pending_approval', 'sending', 'sent', 'send_failed', 'rejected', 'blocked']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export interface AuditEntry {
  at: number;
  action: 'created' | 'approved' | 'sent' | 'send_failed' | 'rejected' | 'blocked';
  by?: string;
  note?: string;
}

export interface DraftRecord {
  id: string;
  leadId: string;
  companyDomain: string;
  draft: EmailDraft;
  contentHash: string;
  status: DraftStatus;
  createdAt: number;
  // The lead as of drafting: its contact is re-checked at send time.
  lead: Lead;
  sent?: { provider: string; messageId: string | null; to: string; at: number };
  history: AuditEntry[];
}

// Sends one approved email to a prospect.
export interface ProspectSender {
  name: string;
  send(email: { to: string; subject: string; text: string; draftId: string }): Promise<{ status: 'sent'; messageId: string | null } | { status: 'failed'; error: string }>;
}

export const ApproveInputSchema = z.strictObject({
  approvedBy: z.string().trim().min(1).max(120),
  // The content hash shown with the draft: you approve exactly what you read.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  // Required when the draft carries review notes (e.g. a social-proof claim to verify).
  acknowledgeReviewNotes: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const RejectInputSchema = z.strictObject({
  rejectedBy: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
});
export type RejectInput = z.infer<typeof RejectInputSchema>;

export type ApprovalOutcome =
  | { ok: true; record: DraftRecord }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'blocked' | 'send_failed'; message: string; record?: DraftRecord };

// One draft per lead, so the id is derivable wherever the lead id is known.
export const draftIdFor = (leadId: string) => `draft_${leadId}`;

// Hash of what the prospect would receive: recipient, subject and body.
export function draftContentHash(draft: EmailDraft): string {
  return createHash('sha256').update(JSON.stringify([draft.to, draft.subject, draft.body])).digest('hex');
}

export interface ApprovalServiceOptions {
  sender: ProspectSender;
  crm: CrmAdapter;
  now?: () => number;
  maxRecords?: number;
}

export function createApprovalService({ sender, crm, now = Date.now, maxRecords = 1000 }: ApprovalServiceOptions) {
  const records = new Map<string, DraftRecord>();

  function register(lead: Lead, draft: EmailDraft): DraftRecord {
    const id = draftIdFor(lead.id);
    const existing = records.get(id);
    if (existing) return existing;
    const at = now();
    const record: DraftRecord = {
      id,
      leadId: lead.id,
      companyDomain: lead.companyDomain,
      draft,
      contentHash: draftContentHash(draft),
      status: 'pending_approval',
      createdAt: at,
      lead,
      history: [{ at, action: 'created' }],
    };
    records.set(id, record);
    if (records.size > maxRecords) records.delete(records.keys().next().value!);
    return record;
  }

  const block = (record: DraftRecord, by: string, note: string): ApprovalOutcome => {
    record.status = 'blocked';
    record.history.push({ at: now(), action: 'blocked', by, note });
    return { ok: false, code: 'blocked', message: note, record };
  };

  async function approve(id: string, input: unknown): Promise<ApprovalOutcome> {
    const parsed = ApproveInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid', message: z.prettifyError(parsed.error) };
    const { approvedBy, contentHash, acknowledgeReviewNotes } = parsed.data;

    const record = records.get(id);
    if (!record) return { ok: false, code: 'not_found', message: `Unknown draft ${id}` };
    if (record.status !== 'pending_approval' && record.status !== 'send_failed') {
      return { ok: false, code: 'conflict', message: `Draft is ${record.status}; only pending drafts can be approved`, record };
    }
    if (contentHash !== record.contentHash) {
      return { ok: false, code: 'conflict', message: 'contentHash does not match this draft; re-read it and approve the current content', record };
    }
    if (record.draft.reviewNotes.length > 0 && acknowledgeReviewNotes !== true) {
      return { ok: false, code: 'invalid', message: `This draft has ${record.draft.reviewNotes.length} review note(s); set acknowledgeReviewNotes: true after reading them`, record };
    }

    // Claim the draft before the first await, so a concurrent approval sees 'sending' and
    // gets a conflict instead of passing the same checks and sending a second time.
    const previousStatus = record.status;
    record.status = 'sending';

    // Send-time checks, fail-closed.
    const at = now();
    const to = sendableEmail(record.lead, at);
    if (!to || to !== record.draft.to) {
      return block(record, approvedBy, record.draft.to ? `Recipient ${record.draft.to} is no longer verified (older than 7 days); re-run the lead` : 'Draft has no verified recipient');
    }
    let suppression: Awaited<ReturnType<CrmAdapter['checkSuppression']>>;
    try {
      suppression = await crm.checkSuppression({ domain: record.companyDomain, email: to });
    } catch (error) {
      // Can't confirm the recipient isn't suppressed: don't send, but allow a later retry.
      record.status = previousStatus;
      return { ok: false, code: 'send_failed', message: `Suppression check failed: ${error instanceof Error ? error.message : String(error)}`, record };
    }
    if (suppression.suppressed) return block(record, approvedBy, `Suppressed at send time: ${suppression.reason}`);

    record.history.push({ at, action: 'approved', by: approvedBy });
    const result = await sender
      .send({ to, subject: record.draft.subject, text: record.draft.body, draftId: record.id })
      .catch(error => ({ status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }));

    if (result.status === 'sent') {
      record.status = 'sent';
      record.sent = { provider: sender.name, messageId: result.messageId, to, at: now() };
      record.history.push({ at: now(), action: 'sent', by: approvedBy, note: `via ${sender.name}${result.messageId ? ` (${result.messageId})` : ''}` });
      return { ok: true, record };
    }
    record.status = 'send_failed';
    record.history.push({ at: now(), action: 'send_failed', by: approvedBy, note: result.error });
    return { ok: false, code: 'send_failed', message: `Send failed via ${sender.name}: ${result.error}. Approve again to retry.`, record };
  }

  function reject(id: string, input: unknown): ApprovalOutcome {
    const parsed = RejectInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid', message: z.prettifyError(parsed.error) };
    const record = records.get(id);
    if (!record) return { ok: false, code: 'not_found', message: `Unknown draft ${id}` };
    if (record.status !== 'pending_approval' && record.status !== 'send_failed') {
      return { ok: false, code: 'conflict', message: `Draft is ${record.status}; only pending drafts can be rejected`, record };
    }
    record.status = 'rejected';
    record.history.push({ at: now(), action: 'rejected', by: parsed.data.rejectedBy, note: parsed.data.reason });
    return { ok: true, record };
  }

  return {
    register,
    approve,
    reject,
    get: (id: string) => records.get(id),
    list: (status?: DraftStatus) => [...records.values()].filter(r => !status || r.status === status),
  };
}

export type ApprovalService = ReturnType<typeof createApprovalService>;
