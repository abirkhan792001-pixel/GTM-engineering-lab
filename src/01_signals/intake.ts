import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CompanyDomainSchema, LeadSchema, type Lead } from '../shared/types';

// Converts an inbound webhook (contact form, signup, pricing-page visit, ...) into a lead.
// The payload is untrusted: it is validated here, unknown top-level keys are dropped, and
// its contents only ever travel as signal rawData, which never counts as verified company
// data. The company is identified by companyDomain, or failing that the email's domain.

export const INTENT_EVENT_TYPES = ['contact_form', 'demo_request', 'signup', 'pricing_page_visit', 'hiring'] as const;

export const IntentSignalSchema = z
  .object({
    eventType: z.enum(INTENT_EVENT_TYPES),
    source: z.string().trim().min(1).max(60),
    companyDomain: z.string().trim().min(1).max(253).optional(),
    email: z.email().max(254).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    companyName: z.string().trim().min(1).max(120).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    // Anything else the sender wants to keep with the signal.
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(s => s.companyDomain || s.email, { message: 'Provide companyDomain or email so the company can be identified', path: ['companyDomain'] });
export type IntentSignal = z.infer<typeof IntentSignalSchema>;

// Personal mailbox providers say nothing about the company.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com',
  'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.net', 'web.de', 'yandex.com',
]);

// A well-formed signal that still can't become a lead (maps to HTTP 422).
export class IntakeError extends Error {}

// "https://www.Acme.com:443/about?x=1" -> "acme.com"
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

export interface IntakeOptions {
  now?: number;
  id?: () => string;
}

export function intentToLead(signal: IntentSignal, { now = Date.now(), id = () => randomUUID().slice(0, 8) }: IntakeOptions = {}): Lead {
  const emailDomain = signal.email?.split('@')[1];
  if (!signal.companyDomain && emailDomain && PERSONAL_EMAIL_DOMAINS.has(normalizeDomain(emailDomain))) {
    throw new IntakeError(`${emailDomain} is a personal email domain; include companyDomain to identify the company`);
  }
  const domain = CompanyDomainSchema.safeParse(normalizeDomain(signal.companyDomain ?? emailDomain ?? ''));
  if (!domain.success) throw new IntakeError(`Could not derive a valid company domain from the signal`);

  // Clock skew can put occurredAt slightly in the future; never record a future signal.
  const occurredAt = signal.occurredAt ? Math.min(Date.parse(signal.occurredAt), now) : now;
  const slug = domain.data.split('.')[0]!.replace(/[^a-z0-9]+/g, '-');

  return LeadSchema.parse({
    id: `lead_${slug}_${id()}`,
    companyDomain: domain.data,
    signals: [
      {
        id: `sig_${slug}_${id()}`,
        source: signal.source,
        timestamp: occurredAt,
        rawData: {
          signalType: signal.eventType.replace(/_/g, '-'),
          ...(signal.companyName && { companyName: signal.companyName }),
          ...(signal.name && { contactName: signal.name }),
          ...(signal.email && { contactEmail: signal.email }),
          ...(signal.metadata && { metadata: signal.metadata }),
        },
      },
    ],
    enrichment: [],
    qualification: null,
    contact: null,
    createdAt: now,
    updatedAt: now,
  });
}
