import { LeadSchema, type Lead } from '../shared/types';
import { evaluateICP, type EvaluateOptions } from './evaluator';
import { checkHardGates } from './rules';

// Qualification: cheap deterministic dealbreaker gates first; only leads that pass
// them reach the (eventually paid) ICP evaluator.

export interface QualifyOptions extends Omit<EvaluateOptions, 'asOfMs'> {
  // Injected clock: used both as the signal-freshness reference and for updatedAt.
  now?: () => number;
}

export async function qualifyLead(lead: Lead, options: QualifyOptions = {}): Promise<Lead> {
  const { now = Date.now, ...evaluateOptions } = options;
  const asOfMs = now();

  const qualification = checkHardGates(lead, evaluateOptions.icp) ?? (await evaluateICP(lead, { ...evaluateOptions, asOfMs }));

  return LeadSchema.parse({ ...lead, qualification, updatedAt: asOfMs });
}
