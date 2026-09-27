import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Firecrawl from '@mendable/firecrawl-js';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_QUALIFIER_MODEL } from '../03_qualification/index';
import { loadDotEnv } from '../shared/env';
import { PROFILES_DIR } from '../shared/profile';
import {
  claudeResearchModel,
  createFirecrawlSearch,
  ollamaResearchModel,
  profileSlug,
  researchCompany,
  ResearchError,
  writeProfile,
  type FirecrawlSearcher,
  type StructuredModel,
} from './index';

// npm run research -- <domain> [--notes file.md]... [--max-pages 15] [--out folder]
//
// Researches a company from public information and writes a client profile (ICP, personas,
// voice, research brief) to profiles/<name>/. Uses the local model when OLLAMA_MODEL is
// set, else Claude when ANTHROPIC_API_KEY is set. With FIRECRAWL_API_KEY it also searches
// the web beyond the company's own site.

function parseArgs(argv: string[]) {
  const args = { domain: '', notes: [] as string[], maxPages: 15, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next) throw new ResearchError(`${arg} needs a value`);
      return next;
    };
    if (arg === '--notes') args.notes.push(value());
    else if (arg === '--max-pages') args.maxPages = Number(value());
    else if (arg === '--out') args.out = value();
    else if (!arg.startsWith('--') && !args.domain) args.domain = arg;
    else throw new ResearchError(`Unknown argument: ${arg}`);
  }
  if (!args.domain) throw new ResearchError('Usage: npm run research -- <domain> [--notes file.md] [--max-pages 15] [--out folder]');
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 50) throw new ResearchError('--max-pages must be between 1 and 50');
  return args;
}

function pickModel(): { model: StructuredModel; corpusChars: number } {
  if (process.env.OLLAMA_MODEL) {
    // A local model's context window is small: give it less source text per call.
    const model = ollamaResearchModel(process.env.OLLAMA_MODEL, { baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL });
    return { model, corpusChars: 24_000 };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { model: claudeResearchModel(new Anthropic(), process.env.QUALIFIER_MODEL || DEFAULT_QUALIFIER_MODEL), corpusChars: 80_000 };
  }
  throw new ResearchError(
    'Research needs a model. Either set OLLAMA_MODEL (free, local: `ollama pull qwen2.5:7b`, then OLLAMA_MODEL=qwen2.5:7b) or ANTHROPIC_API_KEY, in .env or your shell.',
  );
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const { model, corpusChars } = pickModel();
  const notes = args.notes.map(path => ({ name: basename(path), text: readFileSync(path, 'utf8') }));

  let search;
  let render;
  if (process.env.FIRECRAWL_API_KEY) {
    const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
    search = createFirecrawlSearch(firecrawl as unknown as FirecrawlSearcher);
    render = async (url: string) => (await firecrawl.scrape(url, { formats: ['markdown'], onlyMainContent: true })).markdown ?? null;
  }
  console.log(`[research] ${args.domain} with ${model.name}; web search ${search ? 'on (Firecrawl)' : 'off (set FIRECRAWL_API_KEY to add it)'}${notes.length ? `; ${notes.length} notes file(s)` : ''}\n`);

  const profile = await researchCompany({
    domain: args.domain,
    model,
    search,
    render,
    notes,
    maxPages: args.maxPages,
    maxCorpusChars: corpusChars,
    onProgress: message => console.log(message),
  });

  const dir = args.out || join(PROFILES_DIR, profileSlug(args.domain));
  const files = writeProfile(profile, dir);
  // What GTM_PROFILE should be set to: the name for profiles/<name>, else the folder path.
  const profileRef = args.out ? dir : profileSlug(args.domain);

  console.log(`\n[research] ${profile.company}: profile written to ${dir}`);
  console.log(`  industries:  ${profile.icp.targetIndustries.join(', ')}`);
  console.log(`  size:        ${profile.icp.companySize.minEmployees}-${profile.icp.companySize.maxEmployees} employees`);
  console.log(`  countries:   ${profile.icp.targetCountries.join(', ')}`);
  for (const p of profile.personas.personas) console.log(`  persona:     ${p.id}: ${p.targetTitles.slice(0, 4).join(', ')}`);
  console.log(`  sources:     ${profile.sources.length}; verified customers: ${profile.verified.customers}, proof points: ${profile.verified.proofPoints}; dropped as unverified: ${profile.unverified.length}`);
  for (const note of profile.notes) console.log(`  note:        ${note}`);
  console.log(`\n  files: ${files.map(f => basename(f)).join(', ')}`);
  console.log(`\nNext:`);
  console.log(`  1. Review ${join(dir, 'knowledge.md')} (checklist at the top) and edit the files if needed.`);
  console.log(`  2. Run the engine on this profile: add GTM_PROFILE=${profileRef} to .env, or in PowerShell: $env:GTM_PROFILE="${profileRef}"; npm run pipeline:run`);
}

main().catch(error => {
  console.error(`\n[research] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
