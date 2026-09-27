import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import { enrichLead } from '../02_enrichment/index';
import { qualifyLead } from './index';
import { checkHardGates } from './rules';

// Dev runner: 01 mock signals -> 02 enrichment waterfall -> 03 qualification.
// Mock providers and mock scorer only; no network.

async function main(): Promise<void> {
  const leads = generateMockSignals();
  // Fixed clocks so output is reproducible: enrichment 1 min, qualification 2 min after intake.
  const enrichedAt = () => MOCK_AS_OF_MS + 60_000;
  const qualifiedAt = () => MOCK_AS_OF_MS + 120_000;

  console.log(`[03_qualification] qualifying ${leads.length} leads\n`);

  for (const { scenario, lead } of leads) {
    const enriched = await enrichLead(lead, { now: enrichedAt });
    const stage = checkHardGates(enriched) ? 'hard gates (rules.ts)' : 'ICP evaluator (evaluator.ts)';
    const qualified = await qualifyLead(enriched, { now: qualifiedAt });
    const q = qualified.qualification;
    if (!q) throw new Error(`${qualified.companyDomain} has no qualification`);

    console.log(`--- ${qualified.companyDomain} (${scenario}) ---`);
    console.log(`  decision:      ${q.decision}`);
    console.log(`  score:         ${q.score}`);
    console.log(`  decided by:    ${stage}`);
    console.log(`  evidence:`);
    for (const line of q.evidence) console.log(`    - ${line}`);
    console.log(`  missingFields: ${JSON.stringify(q.missingFields)}`);
    console.log();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
