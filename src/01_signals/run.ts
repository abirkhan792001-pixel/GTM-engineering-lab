import { generateMockSignals, MOCK_AS_OF_MS } from './index';

// Dev runner: print the three mock leads, each validated against LeadSchema.

function main(): void {
  const leads = generateMockSignals();
  console.log(`[01_signals] emitted ${leads.length} leads (as_of ${new Date(MOCK_AS_OF_MS).toISOString()})\n`);
  for (const { scenario, lead } of leads) {
    console.log(`--- ${scenario}: ${lead.companyDomain} (${lead.signals.length} signal${lead.signals.length === 1 ? '' : 's'}) ---`);
    console.log(JSON.stringify(lead, null, 2));
    console.log();
  }
}

main();
