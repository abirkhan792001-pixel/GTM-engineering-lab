import type { EmailDraft, Lead } from '../../shared/types';
import { draftContentHash, draftIdFor, type ProspectSender } from '../approvals';
import type { DraftDelivery } from '../index';
import type { FetchLike } from './liveSlack';

// Resend integrations, used when MOCK_MODE=false (see src/runtime.ts):
//
// - createLiveResend: delivers each new DRAFT to the internal review inbox
//   (DRAFT_REVIEW_EMAIL) with the intended recipient shown. Never to the prospect.
// - createResendSender: sends an email to the prospect. Only the approval service calls it,
//   after a named reviewer approves the exact draft and the send-time checks pass.

const RESEND_URL = 'https://api.resend.com/emails';

export interface LiveResendOptions {
  apiKey: string;
  from: string;
  reviewEmail: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function reviewEmailText(draft: EmailDraft, lead: Lead): string {
  const q = lead.qualification;
  return [
    'DRAFT FOR APPROVAL. This email has NOT been sent to the prospect.',
    '',
    `Intended recipient: ${draft.to ?? 'none (no verified contact)'}`,
    `Account: ${lead.companyDomain}${q ? ` (ICP ${q.decision}, score ${q.score})` : ''}`,
    `Persona: ${draft.persona} | Experiment: ${draft.experimentId} / ${draft.variantId}`,
    `Draft id: ${draftIdFor(lead.id)}`,
    `Content hash: ${draftContentHash(draft)}`,
    'To send it, approve it via POST /api/drafts/<draft id>/approve with your name, the content hash' +
      (draft.reviewNotes.length ? ' and acknowledgeReviewNotes: true.' : '.'),
    ...(draft.reviewNotes.length ? ['', 'Review notes:', ...draft.reviewNotes.map(note => `- ${note}`)] : []),
    '',
    `Subject: ${draft.subject}`,
    '-----',
    draft.body,
  ].join('\n');
}

export function createLiveResend({ apiKey, from, reviewEmail, fetch = globalThis.fetch, timeoutMs = 10_000 }: LiveResendOptions): DraftDelivery {
  return {
    name: 'resend',
    async deliver(draft, lead) {
      const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [reviewEmail],
          subject: `[Draft for approval] ${draft.subject}`,
          text: reviewEmailText(draft, lead),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) return { status: 'failed', detail: `Resend returned ${response.status}: ${body.slice(0, 200)}` };
      let id = '';
      try {
        id = String((JSON.parse(body) as { id?: unknown }).id ?? '');
      } catch {
        // A 2xx without a JSON id still means Resend accepted the email.
      }
      return { status: 'sent', detail: `to review inbox ${reviewEmail}${id ? ` (Resend id ${id})` : ''}` };
    },
  };
}

export interface ResendSenderOptions {
  apiKey: string;
  from: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function createResendSender({ apiKey, from, fetch = globalThis.fetch, timeoutMs = 10_000 }: ResendSenderOptions): ProspectSender {
  return {
    name: 'resend',
    async send({ to, subject, text }) {
      const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) return { status: 'failed', error: `Resend returned ${response.status}: ${body.slice(0, 200)}` };
      try {
        const id = (JSON.parse(body) as { id?: unknown }).id;
        return { status: 'sent', messageId: typeof id === 'string' ? id : null };
      } catch {
        return { status: 'sent', messageId: null };
      }
    },
  };
}
