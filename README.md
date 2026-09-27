# GTM-engineering-lab

A code-first go-to-market pipeline in TypeScript: find accounts showing intent, enrich them,
qualify them with Claude, and hand the good ones to sales. Data providers, CRM, email and
Slack are mocked; only the Claude scoring step calls a real API.

## How it works

| Stage | What happens | Result |
|---|---|---|
| 1. Signals | Collect intent signals (hiring posts, pricing-page visits) | One lead per account |
| 2. Enrichment | Apollo first (1¢); Firecrawl (5¢) only if data is still missing | Verified company data and cost |
| 3. Qualification | Dealbreaker rules, then Claude scores against the ICP | Pass, hold or disqualify, with evidence |
| 4. Activation | Suppression check, then CRM record, email draft and Slack alert | Drafts only; nothing is sent |
| 5. Learning | A/B test the email angle, track replies and meetings | Winning variant |

## Project structure

```
src/
  01_signals/        find accounts showing intent
  02_enrichment/     fill in company data
  03_qualification/  score against the ICP and decide
  04_activation/     CRM, email draft, Slack alert
  05_learning/       A/B test the outreach
  context/           ICP, personas, voice rules
  shared/            schemas and config loaders
  runPipeline.ts     run stages 1-4 end to end
tests/               one test file per stage, plus a layout check
docs/                design notes
```

Every stage folder has the same shape: `index.ts` is its entry point (other code imports
only this), `run.ts` is an offline demo, and anything else is internal to the stage.

## Quick start

Requires Node.js 22+.

```sh
npm install
npm test              # all tests, offline
npm run pipeline:run  # full pipeline on 3 mock leads
```

| Command | Shows |
|---|---|
| `npm run signals:dev` | The 3 mock leads |
| `npm run enrich:dev` | Enrichment path and cost per lead |
| `npm run qualify:dev` | Decision, score and evidence |
| `npm run activate:dev` | What happens for each decision |
| `npm run learn:dev` | A/B results across 10 leads |
| `npm run qualify:live` | Real Claude scoring (needs an API key) |

Everything except `qualify:live` runs offline on mock data.

## Claude scoring

Leads that pass the dealbreaker rules go to `claude-sonnet-5`, which returns a score, a
decision and evidence. Claude recommends; code decides: the thresholds in `icp.json` make the
final call, and missing data is double-checked. If the API fails or returns bad output, the
lead is held for review.

```sh
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm run qualify:live    # 2 API calls
```

## Customize

Edit the files in `src/context/` to fit your market:

- `icp.json`: target industries, company size, countries, dealbreakers and scoring
- `personas.json`: buyer titles and pain points
- `voice.md`: tone and email rules, which drafts are checked against

## CI

- **CI** runs typecheck, tests and the offline demos on every push and pull request.
- **Live qualification** runs `qualify:live` on demand. It needs an `ANTHROPIC_API_KEY`
  repository secret and spends a few API credits.

See `docs/reference-architecture-notes.md` for the design background.
