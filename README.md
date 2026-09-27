# GTM-engineering-lab

A code-first go-to-market pipeline in TypeScript: find accounts showing intent, enrich them,
qualify them with Claude, and hand the good ones to sales. It runs fully offline on mocks by
default; set `MOCK_MODE=false` to switch on live Claude, Firecrawl, Slack and Resend.

## How it works

| Stage | What happens | Result |
|---|---|---|
| 1. Signals | Collect intent signals (hiring posts, pricing-page visits) | One lead per account |
| 2. Enrichment | Apollo first (1¢); Firecrawl (5¢) only if data is still missing | Verified company data and cost |
| 3. Qualification | Dealbreaker rules, then Claude scores against the ICP | Pass, hold or disqualify, with evidence |
| 4. Contacts | For passing leads only: find the buyer, then find and verify their email | A verified recipient, or the reason there isn't one |
| 5. Activation | Suppression check, then CRM record, email draft and Slack alert; a person approves each draft before it's sent | Drafts sent to verified contacts only after approval |
| 6. Learning | A/B test the email angle, track replies and meetings | Winning variant |

## Project structure

```
src/
  01_signals/        find accounts showing intent
  02_enrichment/     fill in company data
  03_qualification/  score against the ICP and decide
  04_contacts/       find and verify the buyer to email
  05_activation/     CRM, email draft, Slack alert
  06_learning/       A/B test the outreach
  context/           ICP, personas, voice rules
  shared/            schemas and config loaders
  runPipeline.ts     run stages 1-5 end to end
  runtime.ts         pick mock or live integrations from the config
tests/               one test file per stage, plus a layout check
docs/                design notes
```

Every stage folder has the same shape: `index.ts` is its entry point (other code imports
only this), `run.ts` is an offline demo, and anything else is internal to the stage.
`01_signals/server.ts` is the one extra entry point: the webhook server.

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
| `npm run contacts:dev` | Who gets emailed, and why not when no one does |
| `npm run activate:dev` | What happens for each decision |
| `npm run learn:dev` | A/B results across 10 leads |
| `npm run qualify:live` | Real Claude scoring (needs an API key) |
| `npm run server:dev` | Webhook server on port 3000 (see below) |

Everything runs offline on mock data unless you set `MOCK_MODE=false` or run `qualify:live`.

## Claude scoring

Leads that pass the dealbreaker rules go to `claude-sonnet-5`, which returns a score, a
decision and evidence. Claude recommends; code decides: the thresholds in `icp.json` make the
final call, and missing data is double-checked. If the API fails or returns bad output, the
lead is held for review.

```sh
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm run qualify:live    # 2 API calls
```

## Live mode and the webhook server

Copy `.env.example` to `.env`, set `MOCK_MODE=false`, and add the keys you have. Each
integration goes live only when its settings are present; the rest stay on mocks, and the
server prints a warning for each fallback.

| Integration | Needs | Live behaviour |
|---|---|---|
| Claude scoring | `ANTHROPIC_API_KEY` | Scores leads that pass the dealbreaker rules |
| Firecrawl | `FIRECRAWL_API_KEY` | Scrapes the homepage when Apollo can't fill required fields |
| Slack | `SLACK_WEBHOOK_URL` | Posts Block Kit alerts to the webhook's channel |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` (+ `DRAFT_REVIEW_EMAIL`) | Sends approved drafts to prospects; emails each new draft to your review inbox |

Apollo, contact lookup and the CRM have no live adapters yet, so real domains get no
recipient and nothing is written to a CRM.

```sh
npm run server:dev
curl -X POST localhost:3000/api/webhooks/signal \
  -H 'content-type: application/json' \
  -d '{"eventType":"contact_form","source":"website","email":"lena.hoffmann@northwind-data.example"}'
# 202 {"status":"accepted","leadId":"lead_northwind-data_…","statusUrl":"/api/leads/…"}
curl localhost:3000/api/leads/<leadId>   # decision, contact, outcome and log
```

`eventType` is one of `contact_form`, `demo_request`, `signup`, `pricing_page_visit` or
`hiring`. Send `companyDomain`, or an `email` on the company's domain. Set `WEBHOOK_SECRET`
in live mode; callers then send it in the `x-webhook-secret` header.

## Approving drafts

No email reaches a prospect until a person approves it. Every draft the pipeline produces waits
in an approval queue. Approving it sends it, after these checks run again at send time:

- you approve the exact content you read (its `contentHash`), under your name
- drafts with review notes need `acknowledgeReviewNotes: true`
- the recipient is still verified, within the last 7 days
- neither the recipient nor the account has been suppressed since the draft was made
- it hasn't been sent, rejected or blocked already, so it can't go out twice

```sh
curl localhost:3000/api/drafts?status=pending_approval -H "authorization: Bearer $APPROVAL_TOKEN"
curl localhost:3000/api/drafts/<draftId> -H "authorization: Bearer $APPROVAL_TOKEN"
curl -X POST localhost:3000/api/drafts/<draftId>/approve \
  -H "authorization: Bearer $APPROVAL_TOKEN" -H 'content-type: application/json' \
  -d '{"approvedBy":"you@company.com","contentHash":"<contentHash>","acknowledgeReviewNotes":true}'
# or: POST /api/drafts/<draftId>/reject with {"rejectedBy":"…","reason":"…"}
```

In live mode, sending uses Resend and the approval endpoints need `APPROVAL_TOKEN`; without it
they're disabled. In mock mode, approved emails land in a mock outbox. The queue is kept in
memory, so pending drafts are lost when the server restarts.

## Customize

Edit the files in `src/context/` to fit your market:

- `icp.json`: target industries, company size, countries, dealbreakers and scoring
- `personas.json`: buyer titles and pain points
- `voice.md`: tone and email rules, which drafts are checked against

## CI

- **CI** runs typecheck, tests, the offline demos and a webhook-server smoke test on every
  push and pull request.
- **Live qualification** runs `qualify:live` on demand. It needs an `ANTHROPIC_API_KEY`
  repository secret and spends a few API credits.

See `docs/reference-architecture-notes.md` for the design background.
