// Optional web search for research beyond the company's own website: reviews, competitors,
// funding news, customer stories. Needs a search provider; Firecrawl's search is built in
// (FIRECRAWL_API_KEY). Without one, research uses the website and your notes only.

export interface WebSearchResult {
  url: string;
  title: string;
  text: string;
}

export interface WebSearchProvider {
  name: string;
  search(query: string): Promise<WebSearchResult[]>;
}

// The only Firecrawl client surface used, so tests can inject a fake.
export type FirecrawlSearcher = {
  search(query: string, request?: Record<string, unknown>): Promise<{ web?: Record<string, unknown>[] }>;
};

const str = (value: unknown) => (typeof value === 'string' ? value : '');

export function createFirecrawlSearch(client: FirecrawlSearcher, { limit = 3, maxChars = 6000 } = {}): WebSearchProvider {
  return {
    name: 'firecrawl-search',
    async search(query) {
      // scrapeOptions makes Firecrawl return each result's page content, not just a snippet.
      const data = await client.search(query, { limit, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } });
      return (data.web ?? [])
        .map(result => {
          const metadata = (result.metadata ?? {}) as Record<string, unknown>;
          return {
            url: str(result.url) || str(metadata.sourceURL) || str(metadata.url),
            title: str(result.title) || str(metadata.title),
            text: (str(result.markdown) || str(result.description)).slice(0, maxChars),
          };
        })
        .filter(result => result.url && result.text);
    },
  };
}

// What to look up about a company beyond its own site.
export function researchQueries(companyName: string, domain: string): string[] {
  return [
    `"${companyName}" ${domain} reviews`,
    `"${companyName}" competitors alternatives`,
    `"${companyName}" funding OR raises OR launches`,
    `"${companyName}" case study customer results`,
  ];
}
