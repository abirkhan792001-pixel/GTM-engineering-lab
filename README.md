# GTM-engineering-lab
A code-first Go-To-Market (GTM) engineering framework built in TypeScript. Captures intent signals, runs waterfall enrichment (Apollo, Firecrawl), qualifies leads via LLM scoring (Claude + Zod), and triggers CRM and email activation. A hands-on reference architecture for modern revenue infrastructure and programmatic growth.

## Project structure

```
src/
  01_signals/        intent signal intake (mock generator for now)
  02_enrichment/     waterfall enrichment: Apollo first, Firecrawl only if ICP-required fields are missing (mock providers)
  03_qualification/  hard-gate dealbreakers (rules.ts), then rubric scoring (evaluator.ts; mock now, Claude + Zod next)
  04_activation/     suppression check, then routing: pass -> CRM + email DRAFT + #hot-leads; hold -> #manual-review; disqualify -> inactive (mock CRM/Resend/Slack adapters)
  05_learning/       campaign performance and A/B test analysis
  context/           ICP (icp.json), buyer personas (personas.json), voice/copy rules (voice.md)
  shared/types.ts    Zod contracts: Signal, EnrichmentResult, Qualification, Lead
  shared/            validated loaders for icp.json, personas.json and the rules in voice.md
  runPipeline.ts     end-to-end runner for stages 01 -> 04
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
npm run activate:dev   # activation routing for each decision, plus a suppressed existing customer
npm run pipeline:run   # full 01 -> 04 run with a per-lead report; nothing is ever sent
```
