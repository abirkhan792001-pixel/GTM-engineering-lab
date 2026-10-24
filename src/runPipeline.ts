import { pathToFileURL } from 'node:url';
import { generateMockSignals, mergeByDomain, MOCK_AS_OF_MS } from './01_signals/index';
import { enrichLead, enrichmentStatus, totalEnrichmentCostInCents, type EnrichOptions } from './02_enrichment/index';
import { mockScoreRubric, qualifyLead, type QualifyOptions } from './03_qualification/index';
import { lookupContact, totalContactCostInCents, type LookupOptions } from './04_contacts/index';
import { activateLead, createMockCRM, createMockEmail, createMockNotifier, planOutreach, type ActivateOptions, type OutreachSlot } from './05_activation/index';
import { writeExecutiveReport } from './shared/pdfReporter';
import type { ActivationResult, Lead } from './shared/types';

// End-to-end runner: 01 signals -> 02 enrichment -> 03 qualification -> 04 contacts -> 05 activation.
// Mock providers and adapters only: no network, no CRM writes, no email sent. The runner
// scores with the deterministic offline scorer; processLead() uses Claude unless told otherwise.
// processLead() runs one lead; processBatch() merges a batch to one lead per account and
// lets the priority plan decide who gets today's drafts.
//
//   --export-pdf        also write an executive PDF brief of the run
//   --out <path>        where to write it (default reports/gtm-brief-procuros.pdf)

export const DEFAULT_REPORT_PATH = 'reports/gtm-brief-procuros.pdf';

export interface PipelineOptions {
  // Fixed stage clocks make the whole run reproducible.
  clocks?: { enrich: () => number; qualify: () => number; contacts: () => number; activate: () => number };
  // Enrichment options, e.g. a live Firecrawl provider as the fallback.
  enrich?: Omit<EnrichOptions, 'now'>;
  adapters?: Omit<ActivateOptions, 'now'>;
  // Qualification options, e.g. { scorer: mockScoreRubric } to stay offline, or a Claude client.
  qualify?: Omit<QualifyOptions, 'now'>;
  // Contact lookup options, e.g. injected people-search or email-finder providers.
  contacts?: Omit<LookupOptions, 'now'>;
}

export interface PipelineResult {
  lead: Lead;
  activation: ActivationResult;
}

export interface BatchResult extends PipelineResult {
  // Where the priority plan put this lead (sales, outreach, queued or not qualified), and why.
  slot: OutreachSlot;
}

type Clocks = NonNullable<PipelineOptions['clocks']>;
const realClocks = (): Clocks => ({ enrich: Date.now, qualify: Date.now, contacts: Date.now, activate: Date.now });

// Stages 02-04: enrich, qualify, then find the contact for leads that passed.
async function prepareLead(signalLead: Lead, options: PipelineOptions, clocks: Clocks): Promise<Lead> {
  const enriched = await enrichLead(signalLead, { ...options.enrich, now: clocks.enrich });
  const qualified = await qualifyLead(enriched, { ...options.qualify, now: clocks.qualify });
  return lookupContact(qualified, { ...options.contacts, now: clocks.contacts });
}

export async function processLead(signalLead: Lead, options: PipelineOptions = {}): Promise<PipelineResult> {
  const clocks = options.clocks ?? realClocks();
  const lead = await prepareLead(signalLead, options, clocks);
  const activation = await activateLead(lead, { ...options.adapters, now: clocks.activate });
  return { lead, activation };
}

// Results come back in activation order: sales handoffs, outreach by priority, the queue,
// then leads that did not pass. `dailyOutreachLimit` defaults to routing.json.
export async function processBatch(signalLeads: Lead[], options: PipelineOptions & { dailyOutreachLimit?: number } = {}): Promise<BatchResult[]> {
  const clocks = options.clocks ?? realClocks();
  const prepared: Lead[] = [];
  for (const lead of mergeByDomain(signalLeads)) prepared.push(await prepareLead(lead, options, clocks));

  const byId = new Map(prepared.map(lead => [lead.id, lead]));
  const results: BatchResult[] = [];
  for (const slot of planOutreach(prepared, { asOfMs: clocks.activate(), limit: options.dailyOutreachLimit })) {
    const lead = byId.get(slot.leadId)!;
    const queuedReason = slot.lane === 'queued' ? slot.reason : undefined;
    results.push({ lead, activation: await activateLead(lead, { ...options.adapters, queuedReason, now: clocks.activate }), slot });
  }
  return results;
}

const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const indent = (text: string, pad: string) => text.split('\n').map(line => pad + line).join('\n');

async function main(): Promise<void> {
  const mock = generateMockSignals();
  const scenarioOf = new Map(mock.map(({ scenario, lead }) => [lead.id, scenario]));
  const options: PipelineOptions = {
    clocks: {
      enrich: () => MOCK_AS_OF_MS + 60_000,
      qualify: () => MOCK_AS_OF_MS + 120_000,
      contacts: () => MOCK_AS_OF_MS + 150_000,
      activate: () => MOCK_AS_OF_MS + 180_000,
    },
    // Fresh adapter instances so each run starts with an empty CRM and outbox.
    adapters: { crm: createMockCRM(), email: createMockEmail(), notifier: createMockNotifier() },
    qualify: { scorer: mockScoreRubric },
  };

  console.log(`GTM pipeline: ${mock.length} raw signal leads -> enrichment -> qualification -> contacts -> priority -> activation\n`);

  const results = await processBatch(mock.map(m => m.lead), options);
  for (const { lead, activation, slot } of results) {
    const scenario = scenarioOf.get(lead.id) ?? 'merged';
    const q = lead.qualification!;
    const cost = totalEnrichmentCostInCents(lead);

    console.log(`=== ${lead.companyDomain} (${scenario}) ===`);
    console.log(`  01 signals:       ${lead.signals.map(s => `${String(s.rawData.signalType ?? 'unknown')} via ${s.source}`).join(', ')}`);
    console.log(`  02 enrichment:    ${enrichmentStatus(lead)} via ${lead.enrichment.map(r => `${r.source} [${r.status}]`).join(' -> ')}, ${cost}¢ (${formatUsd(cost)})`);
    console.log(`  03 qualification: ${q.decision}, score ${q.score}${q.missingFields.length ? `, missing ${q.missingFields.join(', ')}` : ''}`);
    const c = lead.contact;
    const contactCost = totalContactCostInCents(lead);
    console.log(`  04 contacts:      ${c ? `${c.status}: ${c.reason}, ${contactCost}¢` : 'skipped (only looked up for passing leads)'}`);
    console.log(`  priority:         ${slot.lane}: ${slot.reason}`);
    console.log(`  05 activation:    ${activation.outcome} (${activation.active ? 'active' : 'inactive'}): ${activation.reason}`);
    for (const line of activation.log) console.log(`      - ${line}`);
    if (activation.draft) {
      const d = activation.draft;
      console.log(`  email ${d.status} (approval required, to: ${d.to ?? 'unresolved'}, ${d.experimentId}/${d.variantId}):`);
      console.log(`      subject: ${d.subject}`);
      console.log(indent(d.body, '      | '));
      console.log(`      checks: ${d.checks.map(c => `${c.name} ${c.passed ? 'ok' : 'FAIL'}`).join(', ')}`);
      for (const note of d.reviewNotes) console.log(`      review: ${note}`);
    }
    for (const alert of activation.alerts) {
      console.log(`  slack ${alert.channel}:`);
      console.log(indent(alert.text, '      > '));
    }
    console.log();
  }

  const count = (outcome: ActivationResult['outcome']) => results.filter(r => r.activation.outcome === outcome).length;
  const spend = results.reduce((sum, r) => sum + totalEnrichmentCostInCents(r.lead), 0);
  console.log('=== Summary ===');
  console.log(`  leads processed:         ${results.length}`);
  const contactSpend = results.reduce((sum, r) => sum + totalContactCostInCents(r.lead), 0);
  console.log(`  enrichment spend:        ${spend}¢ (${formatUsd(spend)})`);
  console.log(`  contact lookup spend:    ${contactSpend}¢ (${formatUsd(contactSpend)})`);
  console.log(`  routed to sales:         ${count('routed_to_sales')}`);
  console.log(`  activated:               ${count('activated')}`);
  console.log(`  queued (over the limit): ${count('queued')}`);
  console.log(`  manual review:           ${count('manual_review')}`);
  console.log(`  disqualified:            ${count('disqualified')}`);
  console.log(`  suppressed:              ${count('suppressed')}`);
  console.log(`  drafts pending approval: ${results.filter(r => r.activation.draft).length}`);
  console.log(`  emails sent:             0 (drafts only; sending requires human approval)`);

  if (process.argv.includes('--export-pdf')) {
    const outFlag = process.argv.indexOf('--out');
    const outPath = outFlag > -1 && process.argv[outFlag + 1] ? process.argv[outFlag + 1]! : DEFAULT_REPORT_PATH;
    // No engagement data in this run, so the A/B card shows the experiment as pending.
    const report = await writeExecutiveReport({ generatedAt: new Date(), dataSource: 'demo', results, experiment: null }, outPath);
    console.log(`\nPDF brief: ${report.path} (${report.pages} page${report.pages === 1 ? '' : 's'}, ${report.model.prospects.length} qualified prospect${report.model.prospects.length === 1 ? '' : 's'})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
