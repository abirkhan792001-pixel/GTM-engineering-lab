import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import { enrichLead } from '../02_enrichment/index';
import { loadDotEnv } from '../shared/env';
import { DEFAULT_QUALIFIER_MODEL, mockScoreRubric } from './evaluator';
import { qualifyLead } from './index';
import { checkHardGates } from './rules';

// Live check of the Claude evaluator against the real Anthropic API. Spends API credits:
// one request per lead that passes the hard gates (2 of the 3 mock leads).
// Reads ANTHROPIC_API_KEY (and optional QUALIFIER_MODEL) from the environment or .env.
// Skips cleanly when no key is configured. Exits 1 if any request fell back to a safe hold,
// so a broken key, model name or schema fails loudly in CI.

const FALLBACK_MARKER = 'LLM evaluation unavailable';

async function main(): Promise<void> {
  const loaded = loadDotEnv();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[qualify:live] SKIPPED: ANTHROPIC_API_KEY is not set.');
    console.log('  Copy .env.example to .env and add your key, or export ANTHROPIC_API_KEY, then rerun.');
    return;
  }
  const model = process.env.QUALIFIER_MODEL || DEFAULT_QUALIFIER_MODEL;
  console.log(`[qualify:live] model ${model}${loaded ? ' (env from .env)' : ''}\n`);

  const now = () => MOCK_AS_OF_MS + 120_000;
  let fallbacks = 0;

  for (const { scenario, lead } of generateMockSignals()) {
    const enriched = await enrichLead(lead, { now: () => MOCK_AS_OF_MS + 60_000 });
    console.log(`--- ${lead.companyDomain} (${scenario}) ---`);

    if (checkHardGates(enriched)) {
      const q = (await qualifyLead(enriched, { now })).qualification!;
      console.log(`  decided by hard gates (no API call): ${q.decision}, score ${q.score}\n`);
      continue;
    }

    const started = Date.now();
    const live = (await qualifyLead(enriched, { now })).qualification!;
    const offline = (await qualifyLead(enriched, { now, scorer: mockScoreRubric })).qualification!;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (live.evidence.some(line => line.startsWith(FALLBACK_MARKER))) fallbacks++;
    const agrees = live.decision === offline.decision ? 'agrees' : 'DIFFERS';
    console.log(`  claude:  ${live.decision}, score ${live.score} (${elapsed}s)`);
    console.log(`  offline: ${offline.decision}, score ${offline.score} -> ${agrees}`);
    console.log(`  missingFields: ${JSON.stringify(live.missingFields)}`);
    for (const line of live.evidence) console.log(`    - ${line}`);
    console.log();
  }

  if (fallbacks > 0) {
    console.error(`[qualify:live] ${fallbacks} evaluation(s) fell back to a safe hold; see the evidence above.`);
    process.exit(1);
  }
  console.log('[qualify:live] ok: every Claude evaluation returned valid structured output.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
