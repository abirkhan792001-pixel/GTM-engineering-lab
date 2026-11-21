import { z } from 'zod';

// Shared contracts for every pipeline stage. Objects are strict (unknown keys are
// rejected) so LLM or provider output that drifts from the contract fails loudly.
// Timestamps are Unix epoch milliseconds and are always passed in, never read from
// the clock inside a stage, so runs can be replayed deterministically.

const EpochMs = z.number().int().nonnegative();
const Score = z.number().min(0).max(100);
const NonEmptyString = z.string().trim().min(1);

export const CompanyDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected a bare domain like acme.com');

// ---------------------------------------------------------------------------
// 01 Signals
// ---------------------------------------------------------------------------

export const SignalSchema = z.strictObject({
  id: NonEmptyString,
  source: NonEmptyString,
  timestamp: EpochMs,
  rawData: z.record(z.string(), z.unknown()),
});
export type Signal = z.infer<typeof SignalSchema>;

// ---------------------------------------------------------------------------
// 02 Enrichment
// ---------------------------------------------------------------------------

export const EnrichmentStatusSchema = z.enum(['enriched', 'failed', 'missing']);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;

export const EnrichmentResultSchema = z
  .strictObject({
    status: EnrichmentStatusSchema,
    data: z.record(z.string(), z.unknown()).nullable(),
    source: NonEmptyString,
    costInCents: z.number().int().nonnegative(),
  })
  .superRefine((result, ctx) => {
    if (result.status === 'enriched' && (result.data === null || Object.keys(result.data).length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: "status 'enriched' requires non-empty data" });
    }
  });
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

// ---------------------------------------------------------------------------
// 03 Qualification
// ---------------------------------------------------------------------------

export const QualificationDecisionSchema = z.enum(['pass', 'hold', 'disqualify']);
export type QualificationDecision = z.infer<typeof QualificationDecisionSchema>;

export const QualificationSchema = z
  .strictObject({
    score: Score,
    decision: QualificationDecisionSchema,
    // Why the decision was made. Every decision, including a hold, must cite something.
    evidence: z.array(NonEmptyString).min(1, 'At least one piece of evidence is required'),
    // Fields that were unknown. Missing evidence earns zero points; it is never guessed.
    missingFields: z.array(NonEmptyString),
  })
  .superRefine((q, ctx) => {
    if (q.decision === 'disqualify' && q.score !== 0) {
      ctx.addIssue({ code: 'custom', path: ['score'], message: "decision 'disqualify' requires score 0" });
    }
  });
export type Qualification = z.infer<typeof QualificationSchema>;

// ---------------------------------------------------------------------------
// 04 Contacts
// ---------------------------------------------------------------------------

export const EmailStatusSchema = z.enum(['valid', 'catch_all', 'invalid', 'unknown']);
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export const PersonSchema = z.strictObject({
  fullName: NonEmptyString,
  title: NonEmptyString,
  // The persona (from personas.json) whose target titles this person matched.
  personaId: NonEmptyString,
  // Other ways to reach them, when the source knew them: LinkedIn steps and call tasks need these.
  linkedinUrl: z.url().optional(),
  phone: z.string().regex(/^\+[0-9][0-9 -]{6,19}$/, 'Expected an E.164-style number like +1 555 0100').optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const ContactLookupStepSchema = z.strictObject({
  // 'signal': the person was named by a signal (a form fill, signup or LinkedIn engager).
  step: z.enum(['signal', 'person_search', 'email_finder']),
  source: NonEmptyString,
  status: z.enum(['found', 'not_found', 'failed']),
  costInCents: z.number().int().nonnegative(),
});
export type ContactLookupStep = z.infer<typeof ContactLookupStepSchema>;

// The buyer to address at an account. Only a 'verified' contact is a sendable recipient.
export const ContactSchema = z
  .strictObject({
    status: z.enum(['verified', 'unverified', 'not_found']),
    person: PersonSchema.nullable(),
    email: z.email().nullable(),
    emailStatus: EmailStatusSchema.nullable(),
    verifiedAt: EpochMs.nullable(),
    steps: z.array(ContactLookupStepSchema).min(1),
    reason: NonEmptyString,
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `${c.status}: ${message}` });
    if (c.status === 'verified' && (!c.person || !c.email || c.emailStatus !== 'valid' || c.verifiedAt === null)) {
      fail('requires a person, an email with status valid, and verifiedAt');
    }
    if (c.status === 'unverified' && !c.person) fail('requires the person that was found');
    if (c.status === 'not_found' && (c.person || c.email)) fail('must not carry a person or email');
  });
export type Contact = z.infer<typeof ContactSchema>;

// ---------------------------------------------------------------------------
// Lead: one account moving through the pipeline
// ---------------------------------------------------------------------------

// A lead's state is defined by which stages have filled their fields: enrichment is
// empty until 02 runs, qualification is null until 03 runs, and contact is null until
// 04 runs (it only runs for leads that passed qualification).
export const LeadSchema = z.strictObject({
  id: NonEmptyString,
  companyDomain: CompanyDomainSchema,
  // An account can carry several distinct signals; they are kept, not collapsed.
  signals: z.array(SignalSchema).min(1),
  enrichment: z.array(EnrichmentResultSchema),
  qualification: QualificationSchema.nullable(),
  contact: ContactSchema.nullable(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
});
export type Lead = z.infer<typeof LeadSchema>;

// ---------------------------------------------------------------------------
// 05 Activation
// ---------------------------------------------------------------------------

export const EmailDraftSchema = z.strictObject({
  // Safeguard: a draft can only ever be a DRAFT awaiting human approval.
  status: z.literal('DRAFT'),
  requiresApproval: z.literal(true),
  // first_touch opens the sequence; follow_up answers new engagement after an earlier touch.
  touch: z.enum(['first_touch', 'follow_up']),
  // 1 for the first touch, then one more per email already sent to the account.
  touchNumber: z.number().int().min(1),
  // The verified contact's email from 04_contacts; null when there is no sendable recipient.
  to: z.email().nullable(),
  persona: NonEmptyString,
  // A/B assignment stamped by 06_learning; carried through to engagement events.
  experimentId: NonEmptyString,
  variantId: NonEmptyString,
  subject: NonEmptyString,
  body: NonEmptyString,
  evidenceUsed: z.array(NonEmptyString),
  checks: z.array(z.strictObject({ name: NonEmptyString, passed: z.boolean(), detail: z.string() })),
  reviewNotes: z.array(NonEmptyString),
});
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

export const SlackChannelSchema = z.enum(['#hot-leads', '#manual-review']);
export type SlackChannel = z.infer<typeof SlackChannelSchema>;

export const SlackAlertSchema = z.strictObject({
  channel: SlackChannelSchema,
  text: NonEmptyString,
  sentAt: EpochMs,
  // 'mock' when no real Slack call was made; live alerts report whether the post succeeded.
  delivery: z.enum(['mock', 'sent', 'failed']),
});
export type SlackAlert = z.infer<typeof SlackAlertSchema>;

export const CrmSyncSchema = z.strictObject({
  action: z.enum(['created', 'updated']),
  companyRecordId: NonEmptyString,
  // Null when no contact person was found for the account.
  contactRecordId: NonEmptyString.nullable(),
  dealId: NonEmptyString,
  url: z.url(),
});
export type CrmSync = z.infer<typeof CrmSyncSchema>;

// ---------------------------------------------------------------------------
// Allbound: channels, ad audiences and the CRM touch log
// ---------------------------------------------------------------------------

export const ChannelSchema = z.enum(['email', 'linkedin', 'call']);
export type Channel = z.infer<typeof ChannelSchema>;

export const AdPlatformSchema = z.enum(['linkedin', 'google', 'meta']);
export type AdPlatform = z.infer<typeof AdPlatformSchema>;

// One step of the sequence for this contact. 'skipped' steps say why (e.g. no verified email).
export const ChannelStepSchema = z.strictObject({
  day: z.number().int().nonnegative(),
  channel: ChannelSchema,
  action: NonEmptyString,
  status: z.enum(['planned', 'skipped']),
  // Where the step goes: the email address, LinkedIn URL or phone number; null when skipped.
  target: NonEmptyString.nullable(),
  reason: NonEmptyString,
});
export type ChannelStep = z.infer<typeof ChannelStepSchema>;

export const AudienceMembershipSchema = z.strictObject({
  platform: AdPlatformSchema,
  // icp-accounts: every activated account. engager-retargeting: accounts that engaged after a touch.
  audience: z.enum(['icp-accounts', 'engager-retargeting']),
  // LinkedIn matches companies by domain; Google and Meta match people by verified email.
  match: z.enum(['company', 'email']),
  status: z.enum(['added', 'already_member', 'skipped', 'failed']),
  detail: NonEmptyString,
});
export type AudienceMembership = z.infer<typeof AudienceMembershipSchema>;

// The same people on every channel at once: sequence steps plus ad audiences.
export const ChannelPlanSchema = z.strictObject({
  mode: z.enum(['first_touch', 'follow_up']),
  steps: z.array(ChannelStepSchema),
  audiences: z.array(AudienceMembershipSchema),
});
export type ChannelPlan = z.infer<typeof ChannelPlanSchema>;

// One entry in an account's CRM timeline. Inbound touches are engagement signals; outbound
// touches are what we did (an email sent, an ad audience joined). Ids make logging idempotent.
export const TouchSchema = z.strictObject({
  id: NonEmptyString,
  companyDomain: CompanyDomainSchema,
  at: EpochMs,
  direction: z.enum(['inbound', 'outbound']),
  channel: z.enum(['email', 'linkedin', 'call', 'ads', 'web', 'sales']),
  kind: NonEmptyString,
  detail: NonEmptyString,
});
export type Touch = z.infer<typeof TouchSchema>;

// routed_to_sales: a hand-raiser (e.g. a demo request) goes to sales directly, with no draft.
// queued: qualified, but over the daily outreach limit; drafted on a later run.
// in_sequence: already emailed and nothing new since; waits for engagement before a follow-up.
export const ActivationOutcomeSchema = z.enum(['suppressed', 'activated', 'routed_to_sales', 'queued', 'in_sequence', 'manual_review', 'disqualified']);
export type ActivationOutcome = z.infer<typeof ActivationOutcomeSchema>;

export const ActivationResultSchema = z
  .strictObject({
    leadId: NonEmptyString,
    companyDomain: CompanyDomainSchema,
    outcome: ActivationOutcomeSchema,
    active: z.boolean(),
    reason: NonEmptyString,
    crm: CrmSyncSchema.nullable(),
    draft: EmailDraftSchema.nullable(),
    // Activated leads only: the sequence steps and ad audiences for this account.
    channels: ChannelPlanSchema.nullable(),
    alerts: z.array(SlackAlertSchema),
    log: z.array(NonEmptyString),
    activatedAt: EpochMs,
  })
  // Routing invariants: each outcome may only carry the side effects it is allowed to have.
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `${r.outcome}: ${message}` });
    const channels = r.alerts.map(a => a.channel);
    switch (r.outcome) {
      case 'activated':
        if (!r.active) fail('must be active');
        if (!r.crm || !r.draft || !r.channels) fail('requires a CRM sync, a draft and a channel plan');
        if (!channels.includes('#hot-leads')) fail('requires a #hot-leads alert');
        break;
      case 'routed_to_sales':
        if (!r.active) fail('must be active');
        if (!r.crm || r.draft) fail('requires a CRM sync and no draft');
        if (!channels.includes('#hot-leads')) fail('requires a #hot-leads alert');
        break;
      case 'in_sequence':
        if (!r.active) fail('must stay active');
        if (!r.crm || r.draft || r.alerts.length > 0) fail('requires a CRM sync, and no draft or alert');
        break;
      case 'queued':
        if (!r.active) fail('must stay active');
        if (r.crm || r.draft || r.alerts.length > 0) fail('must have no CRM sync, draft or alert yet');
        break;
      case 'manual_review':
        if (!r.active) fail('must stay active');
        if (r.crm || r.draft) fail('must not sync to CRM or draft email');
        if (!channels.includes('#manual-review')) fail('requires a #manual-review alert');
        break;
      case 'suppressed':
      case 'disqualified':
        if (r.active) fail('must be inactive');
        if (r.crm || r.draft || r.alerts.length > 0) fail('must have no CRM sync, draft or alert');
        break;
    }
    if (r.outcome !== 'activated' && r.channels) fail('only activated leads carry a channel plan');
  });
export type ActivationResult = z.infer<typeof ActivationResultSchema>;
