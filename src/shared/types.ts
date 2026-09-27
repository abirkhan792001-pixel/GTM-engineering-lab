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
