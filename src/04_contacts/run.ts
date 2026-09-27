import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import { enrichLead } from '../02_enrichment/index';
import { mockScoreRubric, qualifyLead } from '../03_qualification/index';
import type { Lead } from '../shared/types';
import { lookupContact, sendableEmail, totalContactCostInCents } from './index';

// Dev runner: the three mock leads through 02 and 03, then contact lookup. Two extra
// pre-qualified fixtures show the other outcomes: no one with a buyer title, and a
// catch-all mail server. Mock providers only; no network.

const at = (offsetMs: number) => () => MOCK_AS_OF_MS + offsetMs;

const passFixture = (slug: string, name: string): Lead => ({
  id: `lead_${slug}`,
  companyDomain: `${slug}.example`,
  signals: [
    {
      id: `sig_${slug}_hiring_001`,
      source: 'job-board',
      timestamp: MOCK_AS_OF_MS - 2 * 86_400_000,
      rawData: { signalType: 'hiring', companyName: name, jobTitle: 'RevOps Manager' },
    },
  ],
  enrichment: [
    { status: 'enriched', data: { industry: 'B2B SaaS', headcount: 120, hqCountry: 'US' }, source: 'apollo', costInCents: 1 },
  ],
  qualification: { score: 95, decision: 'pass', evidence: ['Fixture: pre-qualified pass for the contacts demo'], missingFields: [] },
  contact: null,
  createdAt: MOCK_AS_OF_MS,
  updatedAt: MOCK_AS_OF_MS,
});

async function main(): Promise<void> {
  const leads: { label: string; lead: Lead }[] = [];
  for (const { scenario, lead } of generateMockSignals()) {
    const enriched = await enrichLead(lead, { now: at(60_000) });
    leads.push({ label: scenario, lead: await qualifyLead(enriched, { now: at(120_000), scorer: mockScoreRubric }) });
  }
  leads.push({ label: 'no-buyer fixture', lead: passFixture('tidewater', 'Tidewater') });
  leads.push({ label: 'catch-all fixture', lead: passFixture('lumenforge', 'Lumenforge') });

  console.log(`[04_contacts] looking up contacts for ${leads.length} leads\n`);
  let spend = 0;
  for (const { label, lead } of leads) {
    const result = await lookupContact(lead, { now: at(150_000) });
    const c = result.contact;
    spend += totalContactCostInCents(result);
    console.log(`--- ${lead.companyDomain} (${label}, ${lead.qualification?.decision}) ---`);
    if (!c) {
      console.log('  skipped: only leads that passed qualification are looked up (0¢)\n');
      continue;
    }
    console.log(`  status:    ${c.status}`);
    console.log(`  reason:    ${c.reason}`);
    console.log(`  steps:     ${c.steps.map(s => `${s.source} [${s.status}, ${s.costInCents}¢]`).join(' -> ')}`);
    console.log(`  recipient: ${sendableEmail(result, at(180_000)()) ?? 'none (not sendable)'}\n`);
  }
  console.log(`contact lookup spend: ${spend}¢`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
