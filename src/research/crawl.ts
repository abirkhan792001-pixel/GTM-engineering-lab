// Website crawler for company research. Free: plain HTTP, no API key. It reads robots.txt
// and the sitemap, then fetches the pages most useful for go-to-market research (pricing,
// customers, product, about, careers...) up to a page budget, and turns each into text.
//
// Page content is untrusted input: it only ever travels as quoted source text, and the
// model that reads it is told to ignore instructions inside it.

export type CrawlFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export type PageKind =
  | 'home'
  | 'pricing'
  | 'customers'
  | 'product'
  | 'use-cases'
  | 'comparison'
  | 'about'
  | 'careers'
  | 'integrations'
  | 'security'
  | 'blog'
  | 'other';

export interface CrawledPage {
  url: string;
  kind: PageKind;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

export interface CrawlResult {
  domain: string;
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
}

export interface CrawlOptions {
  fetch?: CrawlFetch;
  maxPages?: number;
  // Characters of text kept per page.
  maxCharsPerPage?: number;
  timeoutMs?: number;
  // Optional renderer for pages that are mostly JavaScript (little text in the raw HTML),
  // e.g. Firecrawl. Returns the page as text/markdown, or null.
  render?: (url: string) => Promise<string | null>;
  onProgress?: (message: string) => void;
}

export const USER_AGENT = 'GTMLabResearchBot/0.1 (company research; respects robots.txt)';
const THIN_PAGE_CHARS = 200;

// Which pages matter for GTM research, most useful first. Matched against the URL path.
const PAGE_RULES: [PageKind, RegExp, number][] = [
  ['pricing', /pricing|plans|price/, 10],
  ['customers', /customer|case-stud|success|testimonial|stories|clients|reviews/, 9],
  ['product', /product|platform|features|how-it-works|solution|tour/, 8],
  ['use-cases', /industr|use-case|usecase|teams|for-[a-z]/, 7],
  ['comparison', /compar|-vs-|\/vs\/|alternative/, 7],
  ['about', /about|company|mission|team|story/, 6],
  ['careers', /career|jobs|join|hiring|work-with-us/, 5],
  ['integrations', /integrat|partner|marketplace|apps/, 4],
  ['security', /security|trust|compliance|gdpr|privacy-center/, 3],
  ['blog', /blog|resources|news|press|insights|guides/, 1],
];

const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|mp4|mov|webm|css|js|json|xml|txt|woff2?|ttf|eot)$/i;
const LOCALE_PREFIX = /^\/(?!en(?:[-_][a-z]{2})?\/)[a-z]{2}(?:[-_][a-z]{2})?(?:\/|$)/i;

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

export function classifyPage(url: string): { kind: PageKind; priority: number } {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/' || path === '') return { kind: 'home', priority: 100 };
  // Other-language copies of the same pages (e.g. /de/pricing) rank below English ones.
  const penalty = LOCALE_PREFIX.test(path) ? 3 : 0;
  // Shallow pages (/pricing) beat deep ones (/blog/2024/some-post).
  const depth = path.split('/').filter(Boolean).length;
  for (const [kind, pattern, priority] of PAGE_RULES) {
    if (pattern.test(path)) return { kind, priority: priority - penalty - Math.max(0, depth - 1) };
  }
  return { kind: 'other', priority: 0 - penalty - depth };
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const clean = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Code, styling and site chrome (menus, footers, sidebars) carry no company facts.
      .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr|header|footer|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

export function parsePage(url: string, html: string, maxChars: number): Omit<CrawledPage, 'kind'> {
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const metaDescription =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    '';
  const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => clean(m[2]!)).filter(h => h.length > 1 && h.length < 200);
  return {
    url,
    title,
    description: clean(metaDescription),
    headings: [...new Set(headings)].slice(0, 30),
    text: htmlToText(html).slice(0, maxChars),
  };
}

export function extractLinks(html: string, baseUrl: string, domain: string): string[] {
  const links = new Set<string>();
  for (const [, href] of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(href!), baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || normalizeDomain(url.hostname) !== domain || ASSET.test(url.pathname)) continue;
    url.hash = '';
    url.search = '';
    links.add(url.toString());
  }
  return [...links];
}

// ---------------------------------------------------------------------------
// robots.txt and sitemap
// ---------------------------------------------------------------------------

// Disallow rules that apply to every crawler ("User-agent: *"), as path matchers.
export function parseRobots(robots: string): (path: string) => boolean {
  const rules: RegExp[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (!key) continue;
    const field = key.trim().toLowerCase();
    if (field === 'user-agent') {
      // Consecutive User-agent lines form one group.
      applies = (lastWasAgent && applies) || value === '*';
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (applies && field === 'disallow' && value) {
      const pattern = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      rules.push(new RegExp(`^${pattern}`));
    }
  }
  return path => !rules.some(rule => rule.test(path));
}

export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decodeEntities(m[1]!));
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export async function crawlSite(domainInput: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const domain = normalizeDomain(domainInput);
  const maxPages = options.maxPages ?? 15;
  const maxChars = options.maxCharsPerPage ?? 8000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const doFetch: CrawlFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const progress = options.onProgress ?? (() => {});
  const skipped: CrawlResult['skipped'] = [];

  const get = async (url: string): Promise<string | null> => {
    try {
      const res = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        skipped.push({ url, reason: `HTTP ${res.status}` });
        return null;
      }
      return await res.text();
    } catch (error) {
      skipped.push({ url, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  // A missing robots.txt or sitemap is normal; don't report it as a skipped page.
  const forget = (url: string) => {
    if (skipped.at(-1)?.url === url) skipped.pop();
  };

  const origin = `https://${domain}`;
  const robotsTxt = await get(`${origin}/robots.txt`);
  if (robotsTxt === null) forget(`${origin}/robots.txt`);
  const allowed = robotsTxt ? parseRobots(robotsTxt) : () => true;

  // One spelling per page (https, no www, no trailing slash), so www and non-www links or
  // sitemap entries never fetch the same page twice.
  const candidates = new Map<string, number>();
  const consider = (link: string) => {
    const path = new URL(link).pathname.replace(/\/+$/, '') || '/';
    const url = path === '/' ? origin : `${origin}${path}`;
    if (!allowed(path)) {
      if (!skipped.some(s => s.url === url)) skipped.push({ url, reason: 'disallowed by robots.txt' });
      return;
    }
    if (!candidates.has(url)) candidates.set(url, classifyPage(url).priority);
  };

  const homepage = await get(origin);
  if (homepage === null) throw new Error(`Could not load ${origin}: ${skipped.at(-1)?.reason ?? 'unknown error'}`);
  const pages: CrawledPage[] = [];
  const addPage = async (url: string, html: string) => {
    const parsed = parsePage(url, html, maxChars);
    if (parsed.text.length < THIN_PAGE_CHARS && options.render) {
      const rendered = await options.render(url).catch(() => null);
      if (rendered) parsed.text = rendered.slice(0, maxChars);
    }
    pages.push({ ...parsed, kind: classifyPage(url).kind });
    progress(`  read ${url} (${parsed.text.length} chars)`);
  };
  await addPage(origin, homepage);
  for (const link of extractLinks(homepage, origin, domain)) consider(link);

  const sitemap = await get(`${origin}/sitemap.xml`);
  if (sitemap === null) forget(`${origin}/sitemap.xml`);
  if (sitemap) {
    let locs = parseSitemap(sitemap);
    // A sitemap index lists more sitemaps; read up to three of them.
    if (/<sitemapindex/i.test(sitemap)) {
      const nested = await Promise.all(locs.slice(0, 3).map(get));
      locs = nested.flatMap(xml => (xml ? parseSitemap(xml) : []));
    }
    for (const loc of locs.slice(0, 2000)) {
      try {
        const url = new URL(loc);
        if (normalizeDomain(url.hostname) === domain && !ASSET.test(url.pathname)) consider(url.toString());
      } catch {
        // Ignore malformed sitemap entries.
      }
    }
  }

  const visited = new Set([origin]);
  const queue = () =>
    [...candidates.entries()]
      .filter(([url]) => !visited.has(url))
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);

  // Take the best candidate each round; newly found links join the ranking.
  while (pages.length < maxPages) {
    const next = queue()[0];
    if (!next) break;
    const [url] = next;
    visited.add(url);
    const html = await get(url);
    if (html === null) continue;
    await addPage(url, html);
    for (const link of extractLinks(html, url, domain)) consider(link);
  }

  return { domain, pages, skipped };
}
