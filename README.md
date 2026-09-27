# GTM-engineering-lab
A code-first Go-To-Market (GTM) engineering framework built in TypeScript. Captures intent signals, runs waterfall enrichment (Apollo, Firecrawl), qualifies leads via LLM scoring (Claude + Zod), and triggers CRM and email activation. A hands-on reference architecture for modern revenue infrastructure and programmatic growth.

## Project structure

```
src/
  01_signals/        intent signal intake (mock generator for now)
  02_enrichment/     waterfall enrichment: Apollo first, Firecrawl only if ICP-required fields are missing (mock providers)
  03_qualification/  hard-gate dealbreakers (rules.ts), then Claude scoring with Zod-validated structured output (evaluator.ts)
  04_activation/     suppression check, then routing: pass -> CRM + email DRAFT + #hot-leads; hold -> #manual-review; disqualify -> inactive (mock CRM/Resend/Slack adapters)
  05_learning/       deterministic A/B assignment (experiments.ts), engagement tracking and variant metrics (tracker.ts)
  context/           ICP (icp.json), buyer personas (personas.json), voice/copy rules (voice.md)
  shared/types.ts    Zod contracts: Signal, EnrichmentResult, Qualification, Lead
  shared/            validated loaders for icp.json, personas.json and the rules in voice.md
  runPipeline.ts     end-to-end runner for stages 01 -> 04
tests/               node:test suites per stage (01-05) plus shared fixtures
docs/                design notes (see reference-architecture-notes.md)
.github/workflows/  CI (typecheck, tests, offline smoke runs) and a manual live-API check
```

## Run

Requires Node.js 22+.

```sh
npm install
npm test            # node:test suites for stages 01-05 (via tsx)
npm run typecheck   # tsc --noEmit (src and tests)
npm run signals     # emit 3 mock leads validated against LeadSchema
npm run enrich:dev  # run the mock leads through the enrichment waterfall, with cost per lead
npm run qualify:dev # signals -> enrichment -> qualification: decision, score, evidence, missing fields
npm run activate:dev   # activation routing for each decision, plus a suppressed existing customer
npm run pipeline:run   # full 01 -> 04 run with a per-lead report; nothing is ever sent
npm run learn:dev      # 10-lead cohort through 01 -> 04, simulated engagement, A vs B performance table
```

## Live qualification (Anthropic API)

`evaluateICP` calls Claude (`claude-sonnet-5` by default) with the `icp.json` rubric, the lead's
verified enrichment and its signal history, and requests structured output in the
`QualificationSchema` shape. The model's decision is a recommendation: the final call goes
through the deterministic thresholds in `decide()`, and missing required fields are re-checked
in code. API errors, refusals, truncation or malformed output fall back to a safe `hold`.

The dev runners and `npm test` never call the API: runners use the offline scorer and tests
inject a fake client. To exercise the real API:

```sh
cp .env.example .env    # add ANTHROPIC_API_KEY (optional: QUALIFIER_MODEL)
npm run qualify:live    # 2 requests; skips cleanly without a key
```

## CI

- `.github/workflows/ci.yml` runs on every push and pull request: `npm ci`, typecheck, tests,
  and the offline runners. No secrets needed, no API calls.
- `.github/workflows/live-qualification.yml` is manual (Actions > Live qualification > Run
  workflow). It needs an `ANTHROPIC_API_KEY` repository secret and spends a few API credits.
