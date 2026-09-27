import { pathToFileURL } from 'node:url';
import { generateMockSignals, MOCK_AS_OF_MS } from './01_signals/index';
import { enrichLead, enrichmentStatus, totalEnrichmentCostInCents } from './02_enrichment/index';
import { mockScoreRubric } from './03_qualification/evaluator';
import { qualifyLead, type QualifyOptions } from './03_qualification/index';
import { activateLead, type ActivateOptions } from './04_activation/index';
import { createMockCRM } from './04_activation/adapters/mockCRM';
import { createMockEmail } from './04_activation/adapters/mockEmail';
import { createMockNotifier } from './04_activation/adapters/mockNotifier';
import type { ActivationResult, Lead } from './shared/types';

// End-to-end runner: 01 signals -> 02 enrichment -> 03 qualification -> 04 activation.
// Mock providers and adapters only: no network, no CRM writes, no email sent. The runner
// scores with the deterministic offline scorer; processLead() uses Claude unless told otherwise.

export interface PipelineOptions {
  // Fixed stage clocks make the whole run reproducible.
  clocks?: { enrich: () => number; qualify: () => number; activate: () => number };
  adapters?: Omit<ActivateOptions, 'now'>;
  // Qualification options, e.g. { scorer: mockScoreRubric } to stay offline, or a Claude client.
  qualify?: Omit<QualifyOptions, 'now'>;
}

export interface PipelineResult {
  lead: Lead;
  activation: ActivationResult;
}

export async function processLead(signalLead: Lead, options: PipelineOptions = {}): Promise<PipelineResult> {
  const clocks = options.clocks ?? { enrich: Date.now, qualify: Date.now, activate: Date.now };
  const enriched = await enrichLead(signalLead, { now: clocks.enrich });
  const qualified = await qualifyLead(enriched, { ...options.qualify, now: clocks.qualify });
  const activation = await activateLead(qualified, { ...options.adapters, now: clocks.activate });
  return { lead: qualified, activation };
}

const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const indent = (text: string, pad: string) => text.split('\n').map(line => pad + line).join('\n');

async function main(): Promise<void> {
  const leads = generateMockSignals();
  const options: PipelineOptions = {
    clocks: {
      enrich: () => MOCK_AS_OF_MS + 60_000,
      qualify: () => MOCK_AS_OF_MS + 120_000,
      activate: () => MOCK_AS_OF_MS + 180_000,
    },
    // Fresh adapter instances so each run starts with an empty CRM and outbox.
    adapters: { crm: createMockCRM(), email: createMockEmail(), notifier: createMockNotifier() },
    qualify: { scorer: mockScoreRubric },
  };

  console.log(`GTM pipeline: ${leads.length} raw signal leads -> enrichment -> qualification -> activation\n`);

  const results: PipelineResult[] = [];
  for (const { scenario, lead: signalLead } of leads) {
    const result = await processLead(signalLead, options);
    results.push(result);
    const { lead, activation } = result;
    const q = lead.qualification!;
    const cost = totalEnrichmentCostInCents(lead);

    console.log(`=== ${lead.companyDomain} (${scenario}) ===`);
    console.log(`  01 signals:       ${lead.signals.map(s => `${String(s.rawData.signalType ?? 'unknown')} via ${s.source}`).join(', ')}`);
    console.log(`  02 enrichment:    ${enrichmentStatus(lead)} via ${lead.enrichment.map(r => `${r.source} [${r.status}]`).join(' -> ')}, ${cost}¢ (${formatUsd(cost)})`);
    console.log(`  03 qualification: ${q.decision}, score ${q.score}${q.missingFields.length ? `, missing ${q.missingFields.join(', ')}` : ''}`);
    console.log(`  04 activation:    ${activation.outcome} (${activation.active ? 'active' : 'inactive'}): ${activation.reason}`);
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
  console.log(`  enrichment spend:        ${spend}¢ (${formatUsd(spend)})`);
  console.log(`  activated:               ${count('activated')}`);
  console.log(`  manual review:           ${count('manual_review')}`);
  console.log(`  disqualified:            ${count('disqualified')}`);
  console.log(`  suppressed:              ${count('suppressed')}`);
  console.log(`  drafts pending approval: ${results.filter(r => r.activation.draft).length}`);
  console.log(`  emails sent:             0 (drafts only; sending requires human approval)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
