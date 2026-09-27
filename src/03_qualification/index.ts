// Qualification: cheap deterministic dealbreaker gates first; only leads that pass
// them reach the ICP evaluator (Claude by default, a free local model via Ollama, or an
// offline scorer).

import { LeadSchema, type Lead } from '../shared/types';
import { evaluateICP, type EvaluateOptions } from './evaluator';
import { checkHardGates } from './rules';

export { checkHardGates } from './rules';
export {
  DEFAULT_QUALIFIER_MODEL,
  decide,
  evaluateICP,
  mockScoreRubric,
  type ClaudeClient,
  type EvaluateOptions,
  type RubricResult,
  type RubricScorer,
} from './evaluator';
export {
  createOllamaChat,
  createOllamaClient,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_MAX_OUTPUT_TOKENS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  type OllamaChatRequest,
  type OllamaChatResult,
  type OllamaClientOptions,
  type OllamaFetchLike,
} from './localModelClient';

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
