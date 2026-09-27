import { mergedEnrichmentFields } from '../02_enrichment/index';
import { ICP, type Icp } from '../shared/icp';
import { QualificationSchema, type Lead, type Qualification, type Signal } from '../shared/types';

// ICP evaluation for leads that passed the hard gates, in two parts:
//   1. scoreRubric: applies the rubric points to the evidence and lists what is missing.
//      This is the step an LLM call (Claude + a Zod-validated output) will replace; for now
//      it is a deterministic mock so the pipeline runs offline.
//   2. decide: turns the rubric result into pass / hold / disqualify. Plain code, never the
//      LLM, so thresholds live in icp.json and behave the same whichever scorer is used.

const DAY_MS = 86_400_000;

export interface EvaluationContext {
  asOfMs: number;
  icp: Icp;
}

export interface RubricResult {
  score: number;
  evidence: string[];
  missingFields: string[];
  // Points still available from fields that were unknown. Used so missing data can
  // never turn into a "poor fit" disqualification on its own.
  unscoredPoints: number;
}

export type RubricScorer = (lead: Lead, ctx: EvaluationContext) => Promise<RubricResult>;

export interface EvaluateOptions {
  asOfMs?: number;
  icp?: Icp;
  scorer?: RubricScorer;
}

export async function evaluateICP(lead: Lead, options: EvaluateOptions = {}): Promise<Qualification> {
  const ctx: EvaluationContext = { asOfMs: options.asOfMs ?? Date.now(), icp: options.icp ?? ICP };
  const scorer = options.scorer ?? mockScoreRubric;
  return decide(await scorer(lead, ctx), ctx.icp);
}

export function decide(rubric: RubricResult, icp: Icp = ICP): Qualification {
  const { passThreshold, holdThreshold } = icp.qualification;
  const evidence = [...rubric.evidence, `Rubric score: ${rubric.score}/100`];
  const missingFields = [...rubric.missingFields];

  let result: Qualification;
  if (rubric.score + rubric.unscoredPoints < holdThreshold) {
    // Poor fit even if every unknown field had scored full points.
    evidence.push(`Poor fit: best possible score ${rubric.score + rubric.unscoredPoints} is below the hold threshold of ${holdThreshold}`);
    result = { score: 0, decision: 'disqualify', evidence, missingFields };
  } else if (missingFields.length > 0) {
    evidence.push(`Held: cannot pass with missing required fields (${missingFields.join(', ')})`);
    result = { score: rubric.score, decision: 'hold', evidence, missingFields };
  } else if (rubric.score < passThreshold) {
    evidence.push(`Held: score ${rubric.score} is between the hold (${holdThreshold}) and pass (${passThreshold}) thresholds`);
    result = { score: rubric.score, decision: 'hold', evidence, missingFields };
  } else {
    evidence.push(`Passed: score ${rubric.score} >= ${passThreshold} with all required fields verified`);
    result = { score: rubric.score, decision: 'pass', evidence, missingFields };
  }
  return QualificationSchema.parse(result);
}

// Deterministic stand-in for the LLM scorer. Uses only verified enrichment for fit
// and the lead's signals for intent; unknown values earn zero and are listed.
export const mockScoreRubric: RubricScorer = async (lead, { asOfMs, icp }) => {
  const fields = mergedEnrichmentFields(lead);
  const { weights } = icp.scoring;
  const evidence: string[] = [];
  const missingFields = icp.qualification.requiredFields.filter(field => !fields[field]);
  let score = 0;
  let unscoredPoints = 0;

  const industry = fields.industry;
  if (!industry) {
    unscoredPoints += weights.industry;
    evidence.push(`Industry unknown after enrichment (+0)`);
  } else if (icp.targetIndustries.some(t => t.toLowerCase() === String(industry.value).toLowerCase())) {
    score += weights.industry;
    evidence.push(`Industry '${industry.value}' is a target industry (+${weights.industry}) [${industry.source}]`);
  } else {
    evidence.push(`Industry '${industry.value}' is not a target industry (+0) [${industry.source}]`);
  }

  const headcount = fields.headcount;
  const { minEmployees, maxEmployees } = icp.companySize;
  if (!headcount || typeof headcount.value !== 'number') {
    unscoredPoints += weights.companySize;
    evidence.push(`Headcount unknown after enrichment (+0)`);
  } else if (headcount.value >= minEmployees && headcount.value <= maxEmployees) {
    score += weights.companySize;
    evidence.push(`Headcount ${headcount.value} is within target range ${minEmployees}-${maxEmployees} (+${weights.companySize}) [${headcount.source}]`);
  } else {
    evidence.push(`Headcount ${headcount.value} is outside target range ${minEmployees}-${maxEmployees} (+0) [${headcount.source}]`);
  }

  const country = fields.hqCountry;
  if (!country) {
    unscoredPoints += weights.country;
    evidence.push(`HQ country unknown after enrichment (+0)`);
  } else if (icp.targetCountries.includes(String(country.value).toUpperCase())) {
    score += weights.country;
    evidence.push(`HQ country ${country.value} is a target country (+${weights.country}) [${country.source}]`);
  } else {
    evidence.push(`HQ country ${country.value} is not a target country (+0) [${country.source}]`);
  }

  const intent = strongestFreshSignal(lead.signals, asOfMs, icp);
  if (intent) {
    score += intent.points;
    evidence.push(intent.description);
  } else {
    evidence.push(`No fresh intent signal within ${icp.scoring.maxSignalAgeDays} days (+0)`);
  }

  return { score: Math.round(score), evidence, missingFields, unscoredPoints };
};

// Signal points decay linearly to zero at maxSignalAgeDays; only the strongest counts.
// Future-dated or stale signals earn nothing.
function strongestFreshSignal(signals: Signal[], asOfMs: number, icp: Icp): { points: number; description: string } | null {
  const { signalPoints, maxSignalAgeDays } = icp.scoring;
  let best: { points: number; description: string } | null = null;
  for (const signal of signals) {
    const ageDays = (asOfMs - signal.timestamp) / DAY_MS;
    if (ageDays < 0 || ageDays > maxSignalAgeDays) continue;
    const type = typeof signal.rawData.signalType === 'string' ? signal.rawData.signalType : 'unknown';
    const base = signalPoints[type] ?? signalPoints.default ?? 0;
    const points = Math.round(base * (1 - ageDays / maxSignalAgeDays) * 100) / 100;
    if (!best || points > best.points) {
      const detail = typeof signal.rawData.jobTitle === 'string' ? ` for '${signal.rawData.jobTitle}'` : '';
      best = {
        points,
        description: `Fresh ${type} signal${detail} via ${signal.source}, ${ageDays.toFixed(1)} days old (+${points.toFixed(1)} of ${base}) [${signal.id}]`,
      };
    }
  }
  return best;
}
