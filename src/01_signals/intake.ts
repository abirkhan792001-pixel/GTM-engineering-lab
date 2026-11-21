import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AdPlatformSchema, CompanyDomainSchema, LeadSchema, type Lead } from '../shared/types';

// Converts an inbound webhook (contact form, signup, LinkedIn engagement, a reply, an ad click
// from an ad-attribution tool such as Fibbler, a booked meeting, ...) into a lead. Every
// channel's engagement comes in here, so it all lands on the one lead for the account.
// The payload is untrusted: it is validated here, unknown top-level keys are dropped, and
// its contents only ever travel as signal rawData, which never counts as verified company
// data. The company is identified by companyDomain, or failing that the email's domain.

export const INTENT_EVENT_TYPES = [
  'contact_form',
  'demo_request',
  'signup',
  'pricing_page_visit',
  'linkedin_engagement',
  'hiring',
  // Engagement with our outreach: a reply to an email, or a LinkedIn DM reply.
  'email_reply',
  'linkedin_reply',
  // Someone at the account clicked one of our ads (needs adPlatform).
  'ad_click',
  // The conversion: a meeting was booked. Used for attribution.
  'meeting_booked',
] as const;

// What a linkedin_engagement event was, and the signal type (icp.json scoring.signals) it becomes.
const LinkedinEngagementSchema = z.enum(['own_post', 'competitor_post', 'profile_view', 'company_follow']);
export const LINKEDIN_ENGAGEMENTS: Record<z.infer<typeof LinkedinEngagementSchema>, string> = {
  own_post: 'linkedin-own-post-engagement',
  competitor_post: 'linkedin-competitor-post-engagement',
  profile_view: 'linkedin-profile-view',
  company_follow: 'linkedin-company-follow',
};

export const IntentSignalSchema = z
  .object({
    eventType: z.enum(INTENT_EVENT_TYPES),
    source: z.string().trim().min(1).max(60),
    companyDomain: z.string().trim().min(1).max(253).optional(),
    email: z.email().max(254).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    // The person's job title, e.g. from a form field or their LinkedIn headline.
    title: z.string().trim().min(1).max(120).optional(),
    linkedinUrl: z.url().max(300).optional(),
    // Required for linkedin_engagement: liked or commented on your post or a competitor's,
    // viewed your profile, or followed your company page.
    engagement: LinkedinEngagementSchema.optional(),
    // Required for ad_click: which ad network the click came from.
    adPlatform: AdPlatformSchema.optional(),
    companyName: z.string().trim().min(1).max(120).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    // Anything else the sender wants to keep with the signal.
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(s => s.companyDomain || s.email, { message: 'Provide companyDomain or email so the company can be identified', path: ['companyDomain'] })
  .refine(s => (s.eventType === 'linkedin_engagement') === Boolean(s.engagement), {
    message: `engagement (${LinkedinEngagementSchema.options.join(', ')}) is required for linkedin_engagement and only allowed there`,
    path: ['engagement'],
  })
  .refine(s => (s.eventType === 'ad_click') === Boolean(s.adPlatform), {
    message: `adPlatform (${AdPlatformSchema.options.join(', ')}) is required for ad_click and only allowed there`,
    path: ['adPlatform'],
  });
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
          signalType: signal.engagement ? LINKEDIN_ENGAGEMENTS[signal.engagement] : signal.eventType.replace(/_/g, '-'),
          ...(signal.companyName && { companyName: signal.companyName }),
          ...(signal.name && { contactName: signal.name }),
          ...(signal.title && { contactTitle: signal.title }),
          ...(signal.email && { contactEmail: signal.email }),
          ...(signal.linkedinUrl && { contactLinkedinUrl: signal.linkedinUrl }),
          ...(signal.adPlatform && { adPlatform: signal.adPlatform }),
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
