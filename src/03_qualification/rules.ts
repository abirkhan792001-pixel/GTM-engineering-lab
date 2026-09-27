import { mergedEnrichmentFields } from '../02_enrichment/index';
import { ICP, type Icp } from '../shared/icp';
import { QualificationSchema, type Lead, type Qualification } from '../shared/types';

// Deterministic dealbreaker checks, run before any (paid) AI evaluation.
// A gate fires only on verified enrichment evidence of a dealbreaker. An unknown
// value never disqualifies here; the evaluator holds it as a missing field instead.

// Returns a 'disqualify' qualification if any dealbreaker is hit, or null if the lead passes.
export function checkHardGates(lead: Lead, icp: Icp = ICP): Qualification | null {
  const fields = mergedEnrichmentFields(lead);
  const { hardGates, targetCountries } = icp;
  const hits: string[] = [];

  const headcount = fields.headcount;
  if (headcount && typeof headcount.value === 'number' && headcount.value < hardGates.minHeadcount) {
    hits.push(`Headcount (${headcount.value}) is under minimum threshold of ${hardGates.minHeadcount} [${headcount.source}]`);
  }

  const businessModel = fields.businessModel;
  if (businessModel && typeof businessModel.value === 'string') {
    const excluded = hardGates.excludedBusinessModels.find(m => m.toLowerCase() === String(businessModel.value).toLowerCase());
    if (excluded) hits.push(`Business model '${businessModel.value}' is excluded [${businessModel.source}]`);
  }

  const industry = fields.industry;
  if (industry && typeof industry.value === 'string') {
    const keyword = hardGates.excludedIndustryKeywords.find(k => String(industry.value).toLowerCase().includes(k.toLowerCase()));
    if (keyword) hits.push(`Industry '${industry.value}' matches excluded keyword '${keyword}' [${industry.source}]`);
  }

  const country = fields.hqCountry;
  if (hardGates.requireTargetCountry && country && typeof country.value === 'string') {
    if (!targetCountries.includes(country.value.toUpperCase())) {
      hits.push(`HQ country '${country.value}' is not a target country (${targetCountries.join(', ')}) [${country.source}]`);
    }
  }

  if (hits.length === 0) return null;
  return QualificationSchema.parse({
    score: 0,
    decision: 'disqualify',
    evidence: hits.map(hit => `Hit dealbreaker: ${hit}`),
    missingFields: [],
  });
}
