import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import {
  enrichLead,
  enrichmentStatus,
  mergedEnrichmentData,
  missingCriticalFields,
  totalEnrichmentCostInCents,
} from './index';

// Dev runner: push the three mock leads from 01_signals through the waterfall
// and report status, providers called and cost. Mock providers only; no network.

const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const leads = generateMockSignals();
  // Fixed clock one minute after signal intake, so output is reproducible.
  const now = () => MOCK_AS_OF_MS + 60_000;

  console.log(`[02_enrichment] enriching ${leads.length} leads\n`);

  let batchCost = 0;
  for (const { scenario, lead } of leads) {
    const enriched = await enrichLead(lead, { now });
    const cost = totalEnrichmentCostInCents(enriched);
    const missing = missingCriticalFields(enriched);
    const data = mergedEnrichmentData(enriched);
    batchCost += cost;

    console.log(`--- ${enriched.companyDomain} (${scenario}) ---`);
    console.log(`  status:    ${enrichmentStatus(enriched)}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    console.log(`  providers: ${enriched.enrichment.map(r => `${r.source} [${r.status}, ${r.costInCents}¢]`).join(' -> ')}`);
    console.log(`  cost:      ${cost}¢ (${formatUsd(cost)})`);
    console.log(`  data:      ${JSON.stringify({ industry: data.industry, headcount: data.headcount, hqCountry: data.hqCountry, techStack: data.techStack })}`);
    console.log();
  }

  console.log(`batch total: ${batchCost}¢ (${formatUsd(batchCost)})`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
