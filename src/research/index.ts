import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { parseIcp, type Icp } from '../shared/icp';
import { parsePersonas, type Personas } from '../shared/personas';
import { readContextFile, TEMPLATE_CONTEXT_DIR } from '../shared/profile';
import { crawlSite, normalizeDomain, type CrawlFetch, type CrawlOptions } from './crawl';
import { renderKnowledge, renderVoice } from './render';
import { researchQueries, type WebSearchProvider } from './search';
import {
  buildIcp,
  buildPersonas,
  buildSources,
  IcpDraftSchema,
  KnowledgeDraftSchema,
  PersonasDraftSchema,
  PROMPTS,
  renderCorpus,
  systemPrompt,
  verifyKnowledge,
  verifyPhrases,
  VoiceDraftSchema,
  type ProfileMeta,
  type Unverified,
} from './synthesize';
import type { StructuredModel } from './model';

// Company research: builds a client profile (the rule files the engine runs on) from public
// information. Crawl the website -> optional web search -> numbered sources -> four focused
// model calls (company brief, ICP, personas, voice) -> checks against the sources -> files.
// Nothing is written into src/context: profiles go to profiles/<name>/ for review, and the
// engine uses one when GTM_PROFILE=<name> is set.

export { crawlSite, htmlToText, parseRobots, parseSitemap, extractLinks, classifyPage, type CrawledPage, type CrawlFetch, type CrawlResult } from './crawl';
export { claudeResearchModel, ollamaResearchModel, OLLAMA_RESEARCH_DEFAULTS, ResearchModelError, type StructuredModel } from './model';
export { createFirecrawlSearch, researchQueries, type FirecrawlSearcher, type WebSearchProvider, type WebSearchResult } from './search';

export interface ResearchOptions {
  domain: string;
  model: StructuredModel;
  fetch?: CrawlFetch;
  search?: WebSearchProvider;
  render?: CrawlOptions['render'];
  // Knowledge you already have (a client brief, call notes): the most trusted source.
  notes?: { name: string; text: string }[];
  maxPages?: number;
  // How much source text the model reads per call. Keep it small for local models.
  maxCorpusChars?: number;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export interface ResearchProfile {
  slug: string;
  domain: string;
  company: string;
  generatedAt: string;
  model: string;
  icp: Icp;
  personas: Personas;
  voiceMarkdown: string;
  knowledgeMarkdown: string;
  sources: { id: string; url: string; kind: string; title: string }[];
  // Customers and proof points whose quotes were found word for word in their source.
  verified: { customers: number; proofPoints: number };
  unverified: Unverified[];
  notes: string[];
  skipped: { url: string; reason: string }[];
  searches: string[];
}

export class ResearchError extends Error {}

export const profileSlug = (domain: string) => normalizeDomain(domain).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "Peec AI | AI search analytics" -> "Peec AI"; falls back to the domain name.
export function guessCompanyName(title: string, domain: string): string {
  const first = title.split(/\s+[|–—:·-]\s+/)[0]?.trim();
  if (first && first.length <= 40) return first;
  const label = domain.split('.')[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function ask<T extends z.ZodType>(model: StructuredModel, schema: T, system: string, prompt: string, step: string): Promise<z.infer<T>> {
  // One retry: small local models sometimes produce an answer that fails validation.
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let output: unknown;
    try {
      output = await model.generate({ schema, system, prompt });
    } catch (error) {
      throw new ResearchError(`${step}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = schema.safeParse(output);
    if (parsed.success) return parsed.data;
    lastProblem = parsed.error.issues.map(i => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ');
  }
  throw new ResearchError(`${step}: the model's answer did not match the expected shape (${lastProblem})`);
}

export async function researchCompany(options: ResearchOptions): Promise<ResearchProfile> {
  const domain = normalizeDomain(options.domain);
  const progress = options.onProgress ?? (() => {});
  const now = options.now ?? Date.now;

  progress(`Reading ${domain}...`);
  const crawl = await crawlSite(domain, { fetch: options.fetch, maxPages: options.maxPages, render: options.render, onProgress: progress });
  const home = crawl.pages[0];
  const guessedName = guessCompanyName(home?.title ?? '', domain);

  const searches: string[] = [];
  const found: { url: string; title: string; text: string }[] = [];
  if (options.search) {
    const seen = new Set(crawl.pages.map(p => p.url));
    for (const query of researchQueries(guessedName, domain)) {
      searches.push(query);
      progress(`Searching: ${query}`);
      const results = await options.search.search(query).catch(error => {
        progress(`  search failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      for (const result of results) {
        if (seen.has(result.url) || found.length >= 8) continue;
        seen.add(result.url);
        found.push(result);
      }
    }
  }

  const docs = buildSources({ pages: crawl.pages, search: found, notes: options.notes ?? [] }, options.maxCorpusChars ?? 60_000);
  const urlFor = (id: string) => docs.find(d => d.id === id.trim())?.url ?? id;
  const system = systemPrompt(guessedName, domain, renderCorpus(docs));
  progress(`Analysing ${docs.length} sources with ${options.model.name} (4 steps)...`);

  progress('  1/4 company brief');
  const knowledgeDraft = await ask(options.model, KnowledgeDraftSchema, system, PROMPTS.knowledge(guessedName), 'Company brief');
  const company = knowledgeDraft.companyName.trim() || guessedName;
  const knowledge = verifyKnowledge(knowledgeDraft, docs);
  progress('  2/4 ideal customer profile');
  const icpDraft = await ask(options.model, IcpDraftSchema, system, PROMPTS.icp(company, knowledge), 'ICP');
  progress('  3/4 buyer personas');
  const personasDraft = await ask(options.model, PersonasDraftSchema, system, PROMPTS.personas(company, knowledge, icpDraft), 'Personas');
  progress('  4/4 voice');
  const voiceDraft = verifyPhrases(await ask(options.model, VoiceDraftSchema, system, PROMPTS.voice(company, knowledge), 'Voice'), docs);

  const date = new Date(now()).toISOString().slice(0, 10);
  const slug = profileSlug(domain);
  const meta: ProfileMeta = { slug, company, domain, date, sourceCount: docs.length };
  // Scoring weights, thresholds and email limits come from the template, not the model.
  const templateIcp = parseIcp(readContextFile('icp.json', TEMPLATE_CONTEXT_DIR), 'template icp.json');
  const templatePersonas = parsePersonas(readContextFile('personas.json', TEMPLATE_CONTEXT_DIR), 'template personas.json');
  const templateVoice = readContextFile('voice.md', TEMPLATE_CONTEXT_DIR);

  const { icp, notes } = buildIcp(icpDraft, templateIcp, meta);
  const personas = buildPersonas(personasDraft, templatePersonas, meta);
  const voiceMarkdown = renderVoice({ company, domain, date, voice: voiceDraft, proofPoints: knowledge.proofPoints, urlFor, template: templateVoice });
  const knowledgeMarkdown = renderKnowledge({
    company,
    domain,
    date,
    model: options.model.name,
    knowledge,
    icpDraft,
    buildNotes: notes,
    docs,
    unverified: knowledge.unverified,
    skipped: crawl.skipped,
  });

  return {
    slug,
    domain,
    company,
    generatedAt: new Date(now()).toISOString(),
    model: options.model.name,
    icp,
    personas,
    voiceMarkdown,
    knowledgeMarkdown,
    sources: docs.map(({ id, url, kind, title }) => ({ id, url, kind, title })),
    verified: { customers: knowledge.customers.length, proofPoints: knowledge.proofPoints.length },
    unverified: knowledge.unverified,
    notes,
    skipped: crawl.skipped,
    searches,
  };
}

// Writes the profile folder the engine can run on (GTM_PROFILE=<slug>).
export function writeProfile(profile: ResearchProfile, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const files: [string, string][] = [
    ['icp.json', `${JSON.stringify(profile.icp, null, 2)}\n`],
    ['personas.json', `${JSON.stringify(profile.personas, null, 2)}\n`],
    ['voice.md', profile.voiceMarkdown],
    ['knowledge.md', profile.knowledgeMarkdown],
    [
      'sources.json',
      `${JSON.stringify(
        { company: profile.company, domain: profile.domain, generatedAt: profile.generatedAt, model: profile.model, sources: profile.sources, searches: profile.searches, unverified: profile.unverified, skipped: profile.skipped },
        null,
        2,
      )}\n`,
    ],
  ];
  return files.map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  });
}
