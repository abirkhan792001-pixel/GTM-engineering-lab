# GTM-engineering-lab
A code-first Go-To-Market (GTM) engineering framework built in TypeScript. Captures intent signals, runs waterfall enrichment (Apollo, Firecrawl), qualifies leads via LLM scoring (Claude + Zod), and triggers CRM and email activation. A hands-on reference architecture for modern revenue infrastructure and programmatic growth.

## Project structure

```
src/
  01_signals/        intent signal intake (mock generator for now)
  02_enrichment/     waterfall enrichment (Apollo, Firecrawl)
  03_qualification/  LLM scoring (Claude + Zod) and deterministic gates
  04_activation/     CRM sync and email drafts
  05_learning/       campaign performance and A/B test analysis
  context/           ICP (icp.json), buyer personas (personas.json), voice/copy rules (voice.md)
  shared/types.ts    Zod contracts: Signal, EnrichmentResult, Qualification, Lead
docs/                design notes (see reference-architecture-notes.md)
```

## Run

Requires Node.js 22+.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run signals     # emit 3 mock leads validated against LeadSchema
```
