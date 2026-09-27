import { generateMockSignals, MOCK_AS_OF_MS } from '../01_signals/index';
import { enrichLead } from '../02_enrichment/index';
import { loadDotEnv } from '../shared/env';
import { mockScoreRubric } from './evaluator';
import { qualifyLead } from './index';
import { createOllamaClient, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from './localModelClient';
import { checkHardGates } from './rules';

// Scores the mock leads with a free local model through Ollama, next to the offline scorer.
// No API key and no cost. Reads OLLAMA_MODEL (default llama3.2) and OLLAMA_BASE_URL from the
// environment or .env. Skips cleanly when Ollama isn't running or the model isn't pulled.

const FALLBACK_MARKER = 'LLM evaluation unavailable';

// Returns why Ollama can't be used, or null when the server is up and has the model.
async function ollamaProblem(baseUrl: string, model: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return `Ollama is not reachable at ${baseUrl}.`;
  }
  if (!res.ok) return `Ollama at ${baseUrl} answered ${res.status}.`;
  const { models = [] } = (await res.json()) as { models?: { name: string }[] };
  const names = models.map(m => m.name);
  // "llama3.2" matches the pulled tag "llama3.2:latest".
  if (!names.some(name => name === model || name === `${model}:latest`)) return `Model '${model}' is not pulled (have: ${names.join(', ') || 'none'}).`;
  return null;
}

async function main(): Promise<void> {
  loadDotEnv();
  const model = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;

  const problem = await ollamaProblem(baseUrl, model);
  if (problem) {
    console.log(`[qualify:local] SKIPPED: ${problem}`);
    console.log(`  Install Ollama (https://ollama.com), run 'ollama pull ${model}', keep it running, then rerun.`);
    return;
  }
  console.log(`[qualify:local] model ${model} via Ollama at ${baseUrl}\n`);

  const client = createOllamaClient({ baseUrl });
  const now = () => MOCK_AS_OF_MS + 120_000;
  let fallbacks = 0;

  for (const { scenario, lead } of generateMockSignals()) {
    const enriched = await enrichLead(lead, { now: () => MOCK_AS_OF_MS + 60_000 });
    console.log(`--- ${lead.companyDomain} (${scenario}) ---`);

    if (checkHardGates(enriched)) {
      const q = (await qualifyLead(enriched, { now, scorer: mockScoreRubric })).qualification!;
      console.log(`  decided by hard gates (no model call): ${q.decision}, score ${q.score}\n`);
      continue;
    }

    const started = Date.now();
    const local = (await qualifyLead(enriched, { now, client, model })).qualification!;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const offline = (await qualifyLead(enriched, { now, scorer: mockScoreRubric })).qualification!;

    if (local.evidence.some(line => line.startsWith(FALLBACK_MARKER))) fallbacks++;
    const agrees = local.decision === offline.decision ? 'agrees' : 'DIFFERS';
    console.log(`  ${model}: ${local.decision}, score ${local.score} (${elapsed}s)`);
    console.log(`  offline: ${offline.decision}, score ${offline.score} -> ${agrees}`);
    for (const line of local.evidence) console.log(`    - ${line}`);
    console.log();
  }

  if (fallbacks > 0) {
    console.error(`[qualify:local] ${fallbacks} evaluation(s) fell back to a safe hold; see the evidence above.`);
    process.exit(1);
  }
  console.log('[qualify:local] ok: every local evaluation returned valid structured output.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
