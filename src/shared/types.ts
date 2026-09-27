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
// Lead: one account moving through the pipeline
// ---------------------------------------------------------------------------

// A lead's state is defined by which stages have filled their fields:
// enrichment is empty until 02 runs, qualification is null until 03 runs.
export const LeadSchema = z.strictObject({
  id: NonEmptyString,
  companyDomain: CompanyDomainSchema,
  // An account can carry several distinct signals; they are kept, not collapsed.
  signals: z.array(SignalSchema).min(1),
  enrichment: z.array(EnrichmentResultSchema),
  qualification: QualificationSchema.nullable(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
});
export type Lead = z.infer<typeof LeadSchema>;

// ---------------------------------------------------------------------------
// 04 Activation
// ---------------------------------------------------------------------------

export const EmailDraftSchema = z.strictObject({
  // Safeguard: a draft can only ever be a DRAFT awaiting human approval.
  status: z.literal('DRAFT'),
  requiresApproval: z.literal(true),
  // Null until a verified contact email is resolved; a draft without one cannot be approved.
  to: z.email().nullable(),
  persona: NonEmptyString,
  // A/B assignment stamped by 05_learning; carried through to engagement events.
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
});
export type SlackAlert = z.infer<typeof SlackAlertSchema>;

export const CrmSyncSchema = z.strictObject({
  action: z.enum(['created', 'updated']),
  companyRecordId: NonEmptyString,
  dealId: NonEmptyString,
  url: z.url(),
});
export type CrmSync = z.infer<typeof CrmSyncSchema>;

export const ActivationOutcomeSchema = z.enum(['suppressed', 'activated', 'manual_review', 'disqualified']);
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
        if (!r.crm || !r.draft) fail('requires a CRM sync and a draft');
        if (!channels.includes('#hot-leads')) fail('requires a #hot-leads alert');
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
  });
export type ActivationResult = z.infer<typeof ActivationResultSchema>;
