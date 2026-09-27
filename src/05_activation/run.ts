import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import { enrichLead } from '../02_enrichment/index';
import { mockScoreRubric, qualifyLead } from '../03_qualification/index';
import { lookupContact } from '../04_contacts/index';
import type { Lead } from '../shared/types';
import { createMockCRM } from './adapters/mockCRM';
import { createMockEmail } from './adapters/mockEmail';
import { createMockNotifier } from './adapters/mockNotifier';
import { activateLead } from './index';

// Dev runner for activation routing. Runs the three mock leads through 02, 03 and 04,
// plus one hand-built fixture: an existing customer that *passes* qualification,
// to show that suppression halts activation even for a 'pass'.

const at = (offsetMs: number) => () => MOCK_AS_OF_MS + offsetMs;

const existingCustomerFixture: Lead = {
  id: 'lead_brightledger',
  companyDomain: 'brightledger.example',
  signals: [
    {
      id: 'sig_brightledger_hiring_001',
      source: 'job-board',
      timestamp: MOCK_AS_OF_MS - 3 * 86_400_000,
      rawData: { signalType: 'hiring', companyName: 'BrightLedger', jobTitle: 'VP Revenue Operations' },
    },
  ],
  enrichment: [
    { status: 'enriched', data: { industry: 'Fintech Infrastructure', headcount: 210, hqCountry: 'GB' }, source: 'apollo', costInCents: 1 },
  ],
  qualification: {
    score: 97,
    decision: 'pass',
    evidence: ['Fixture: pre-qualified pass for the suppression demo'],
    missingFields: [],
  },
  contact: null,
  createdAt: MOCK_AS_OF_MS,
  updatedAt: MOCK_AS_OF_MS,
};

async function main(): Promise<void> {
  const qualified: { label: string; lead: Lead }[] = [];
  for (const { scenario, lead } of generateMockSignals()) {
    const enriched = await enrichLead(lead, { now: at(60_000) });
    const scored = await qualifyLead(enriched, { now: at(120_000), scorer: mockScoreRubric });
    qualified.push({ label: scenario, lead: await lookupContact(scored, { now: at(150_000) }) });
  }
  qualified.push({ label: 'existing-customer fixture', lead: existingCustomerFixture });

  const adapters = { crm: createMockCRM(), email: createMockEmail(), notifier: createMockNotifier() };
  console.log(`[05_activation] routing ${qualified.length} qualified leads\n`);

  for (const { label, lead } of qualified) {
    const result = await activateLead(lead, { ...adapters, now: at(180_000) });
    console.log(`--- ${lead.companyDomain} (${label}) ---`);
    console.log(`  decision -> outcome: ${lead.qualification?.decision} -> ${result.outcome} (${result.active ? 'active' : 'inactive'})`);
    for (const line of result.log) console.log(`    - ${line}`);
    console.log();
  }

  console.log(`CRM records: ${[...adapters.crm.records.keys()].join(', ') || 'none'}`);
  console.log(`Slack outbox: ${adapters.notifier.outbox.map(a => a.channel).join(', ') || 'empty'}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
