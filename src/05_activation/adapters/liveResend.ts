import type { EmailDraft, Lead } from '../../shared/types';
import type { DraftDelivery } from '../index';
import type { FetchLike } from './liveSlack';

// Live draft delivery through Resend. Used when MOCK_MODE=false and RESEND_API_KEY,
// RESEND_FROM and DRAFT_REVIEW_EMAIL are all set (see src/runtime.ts).
//
// Safeguard: Resend has no drafts; anything posted to it is sent. So this adapter delivers
// each DRAFT to the internal review inbox (DRAFT_REVIEW_EMAIL), with the intended recipient
// shown in the body. It never emails the prospect. Sending to prospects needs an explicit
// approval step, which is deliberately not part of the automated pipeline.

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
