# GTM-engineering-lab
A code-first Go-To-Market (GTM) engineering framework built in TypeScript. Captures intent signals, runs waterfall enrichment (Apollo, Firecrawl), qualifies leads via LLM scoring (Claude + Zod), and triggers CRM and email activation. A hands-on reference architecture for modern revenue infrastructure and programmatic growth.

## Project structure

```
src/
  01_signals/        intent signal intake (mock generator for now)
  02_enrichment/     waterfall enrichment: Apollo first, Firecrawl only if ICP-required fields are missing (mock providers)
  03_qualification/  hard-gate dealbreakers (rules.ts), then rubric scoring (evaluator.ts; mock now, Claude + Zod next)
  04_activation/     CRM sync and email drafts
  05_learning/       campaign performance and A/B test analysis
  context/           ICP (icp.json), buyer personas (personas.json), voice/copy rules (voice.md)
  shared/types.ts    Zod contracts: Signal, EnrichmentResult, Qualification, Lead
  shared/icp.ts      validated loader for context/icp.json
docs/                design notes (see reference-architecture-notes.md)
```

## Run

Requires Node.js 22+.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run signals     # emit 3 mock leads validated against LeadSchema
npm run enrich:dev  # run the mock leads through the enrichment waterfall, with cost per lead
npm run qualify:dev # signals -> enrichment -> qualification: decision, score, evidence, missing fields
```
