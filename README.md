# GTM-engineering-lab

A code-first go-to-market pipeline in TypeScript: find accounts showing intent, enrich them,
qualify them with Claude, and hand the good ones to sales. It runs inbound and outbound as one
allbound motion: sourced lists and inbound signals land on the same account, every channel
works the same people, and all engagement flows back to one CRM timeline. It runs fully
offline on mocks by default; set `MOCK_MODE=false` to switch on live Claude, Firecrawl, Slack
and Resend.

## How it works

| Stage | What happens | Result |
|---|---|---|
| 1. Signals | Source accounts from list providers, and collect intent and engagement signals (demo requests, signups, LinkedIn engagement, replies, ad clicks, hiring posts); merge them by company domain | One lead per account, carrying every signal |
| 2. Enrichment | Apollo first (1¢); Firecrawl (5¢) only if data is still missing | Verified company data and cost |
| 3. Qualification | Dealbreaker rules, then Claude scores against the ICP; intent points follow the signal's warmth tier | Pass, hold or disqualify, with evidence |
| 4. Contacts | For passing leads only: the person a signal names comes first, else find the buyer (trying the next persona when one doesn't match); then an email waterfall verifies their address | A verified recipient, or LinkedIn steps only, or the reason there's neither |
| 5. Activation | Suppression check; demo requests, replies and meetings go straight to sales; the rest are ranked warmest first under a daily limit, then get a CRM record, a channel plan (email, LinkedIn, call, ad audiences), an email draft and a Slack alert; engagement after an email gets a follow-up and retargeting; a person approves each draft before it's sent | Drafts sent to verified contacts only after approval, and a CRM timeline of every touch |
| 6. Learning | A/B test the email angle, track replies and meetings, attribute booked meetings to the touches before them | Winning variant, and what led to each meeting |

## Project structure

```
src/
  01_signals/        source account lists and collect signals
  02_enrichment/     fill in company data
  03_qualification/  score against the ICP and decide
  04_contacts/       find and verify the buyer to email
  05_activation/     CRM, channel plan, ad audiences, email draft, Slack alert
  06_learning/       A/B test the outreach, attribute meetings
  context/           ICP, personas, routing, channels, voice rules
  shared/            schemas and config loaders
  runPipeline.ts     run stages 1-5 end to end
  runAllbound.ts     the allbound loop: source, run every channel, follow up, attribute
  runtime.ts         pick mock or live integrations from the config
reports/             generated PDF briefs (git-ignored)
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
npm run pipeline:run  # full pipeline on 4 mock leads
```

| Command | Shows |
|---|---|
| `npm run signals:dev` | The 4 mock leads |
| `npm run enrich:dev` | Enrichment path and cost per lead |
| `npm run qualify:dev` | Decision, score and evidence |
| `npm run contacts:dev` | Who gets emailed, and why not when no one does |
| `npm run activate:dev` | What happens for each decision |
| `npm run pipeline:run` | Every stage per lead, in priority order |
| `npm run allbound:dev` | The allbound loop over five days, from sourcing to an attributed meeting |
| `npm run learn:dev` | A/B results across 10 leads |
| `npm run qualify:live` | Real Claude scoring (needs an API key) |
| `npm run server:dev` | Webhook server on port 3000 (see below) |
| `npm run report:pdf` | Full pipeline plus a PDF executive brief in `reports/` |

Everything runs offline on mock data unless you set `MOCK_MODE=false` or run `qualify:live`.

## Warmth tiers: who gets the first message

Every signal type has a warmth tier in `icp.json` (`scoring.signals`). The warmest fresh signal
(30 days by default) decides three things: how many intent points a lead earns, who is
addressed, and who goes first.

| Tier | Meaning | Signal types | Points |
|---|---|---|---|
| 5 | Hand-raise: first-party data only you have | `meeting-booked`, `demo-request`, `contact-form`, `signup`, `email-reply`, `linkedin-reply` | 26-30 |
| 4 | Engagement | `linkedin-own-post-engagement`, `pricing-page-visit`, `linkedin-profile-view`, `linkedin-company-follow`, `linkedin-competitor-post-engagement`, `ad-click` | 16-24 |
| 3 | Trigger event | `hiring` | 15 |
| 2 | Fit (lookalikes, ICP lists) | `account-list` | 8 |
| 1 | Data only | anything unlisted (`default`) | 5 |

The config fails to load if a colder tier ever earns more points than a warmer one.

- **One lead per account.** Signals for the same domain are merged onto one lead. An exact
  repeat (same source, time and payload) is dropped, and the merged lead re-runs the pipeline.
- **The named person first.** When a fresh signal names someone (a form fill, a signup, a
  LinkedIn engager), 04_contacts addresses them as long as their title matches a persona. It
  verifies the email they gave if it's on the company's domain. Otherwise it falls back to the
  usual buyer search and records why.
- **Hand-raisers skip outreach.** A qualified lead with a fresh signal listed in
  `routing.json` (`routeToSalesSignals`, by default `demo-request`, `email-reply`,
  `linkedin-reply` and `meeting-booked`) is `routed_to_sales`: it
  gets a CRM record and a `#hot-leads` alert telling a rep to reply personally, and no
  sequence draft.
- **Warmest first, under a daily limit.** In a batch (`processBatch`), the other qualified
  leads are ranked by tier, then ICP score, then signal recency. The top
  `dailyOutreachLimit` (default 5) get drafts and the rest are `queued` with their rank. The
  webhook server lists pending drafts in the same order and sends at most that many emails
  per UTC day.
- **Signals decide who, not what to say.** Website visits and LinkedIn engagement are never
  mentioned to the prospect. A draft's one observation comes only from a public job posting.

## Allbound: every channel on the same people

`npm run allbound:dev` runs the whole loop offline (`src/runAllbound.ts`). These are the five layers:

1. **Source.** `sourceAccounts()` pulls accounts from list providers (mocks of BlitzAPI, Sales
   Navigator, Prospeo, AI Ark and Ocean.io), normalises their domains and merges them into one
   lead per account. Each listing becomes an `account-list` signal (tier 2), so you can see
   which lists found an account. A provider that fails is reported and the others still run.
2. **Qualify.** The ICP scoring is unchanged. Contact lookup tries the persona sized for the
   account, then the next role: RevOps, founders, then Demand Gen / VP Marketing and CRO /
   VP Sales. Email goes through a waterfall (`emailFinders`, by default two providers): each
   provider is a priced step, and the first valid address wins. If nothing verifies but we
   know the person's LinkedIn profile, the contact runs on **LinkedIn steps only**.
3. **Run every channel.** An activated lead gets a channel plan from `channels.json`: email,
   LinkedIn and call steps. Each step is planned only when the contact can be reached that way.
   The account also joins ad audiences: LinkedIn by company domain, Google and Meta by verified
   email (hashed). `selectPostsToPromote()` picks which founder posts to run as ads, by
   engagement rate on enough impressions, and says why every other post was held.
4. **Capture.** Replies (`email_reply`, `linkedin_reply`), ad clicks from an attribution tool
   like Fibbler (`ad_click` with `adPlatform`), LinkedIn engagement and booked meetings all
   arrive at the same webhook and land on the account's lead. Activation logs each engagement
   signal on the account's CRM timeline. Each approved email and each ad audience the
   account joins is logged there too.
5. **Follow up, then attribute.** When an account we already emailed engages again, it gets
   a follow-up draft (touch 2, 3, …; 60 words max, and it never says what they did) and joins
   the retargeting audiences, so the follow-up and the ads run at the same time. With nothing
   new since the last email, the lead is `in_sequence` and nothing is drafted. A booked meeting goes
   to sales, with a log line listing every touch before it, split into what we did and how
   they engaged. `GET /api/accounts/:domain/timeline` returns the same timeline and attribution.

The sequence steps are a plan for a sequencer such as OXYGEN, and a person signs off before
any of them reach the prospect. Only the email step is sent from here, after approval.
List sources, the second email finder, ad audiences and the sequencer are mocks; see
`docs/allbound-architecture-notes.md` for what a live setup still needs.

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

Apollo, contact lookup, account lists, ad audiences and the CRM have no live adapters yet, so
real domains get no recipient, nothing is uploaded to an ad platform, and nothing is written
to a CRM.

```sh
npm run server:dev
curl -X POST localhost:3000/api/webhooks/signal \
  -H 'content-type: application/json' \
  -d '{"eventType":"contact_form","source":"website","email":"lena.hoffmann@northwind-data.example"}'
# 202 {"status":"accepted","leadId":"lead_northwind-data_…","statusUrl":"/api/leads/…"}
curl localhost:3000/api/leads/<leadId>   # decision, contact, outcome and log
```

`eventType` is one of `contact_form`, `demo_request`, `signup`, `pricing_page_visit`,
`linkedin_engagement`, `hiring`, `email_reply`, `linkedin_reply`, `ad_click` or
`meeting_booked`. Send `companyDomain`, or an `email` on the company's domain.
`linkedin_engagement` also needs `engagement`: `own_post`, `competitor_post`,
`profile_view` or `company_follow`. `ad_click` needs `adPlatform`: `linkedin`, `google` or
`meta`. Optional `name`, `title` and `linkedinUrl` say who it
was, so that person can be addressed. Set `WEBHOOK_SECRET` in live mode; callers then send
it in the `x-webhook-secret` header.

```sh
curl -X POST localhost:3000/api/webhooks/signal -H 'content-type: application/json' \
  -d '{"eventType":"linkedin_engagement","engagement":"own_post","source":"linkedin","companyDomain":"northwind-data.example","name":"Lena Hoffmann","title":"Director of Sales Operations"}'
# 202 {"status":"merged","signalCount":2,"leadId":"lead_northwind-data_…",…}
```

A signal for a company the server already knows answers `"status":"merged"` with the same
`leadId` and re-runs the lead. An exact repeat answers `200` with `"status":"duplicate"` and
runs nothing. A lead is never run twice at once: a signal that arrives mid-run queues one
more run. Leads, like drafts, are kept in memory.

`GET /api/accounts/<domain>/timeline` lists every touch logged for an account (engagement in,
emails and ad audiences out). Once a meeting is booked, it also returns the meeting's
attribution. It uses the same token rules as the draft endpoints, because it names people.

## Approving drafts

No email reaches a prospect until a person approves it. Every draft the pipeline produces waits
in an approval queue. Approving it sends it, after these checks run again at send time:

- you approve the exact content you read (its `contentHash`), under your name
- drafts with review notes need `acknowledgeReviewNotes: true`
- the recipient is still verified, within the last 7 days
- neither the recipient nor the account has been suppressed since the draft was made
- it hasn't been sent, rejected or blocked already, so it can't go out twice
- fewer than `dailyOutreachLimit` emails have gone out today (UTC); otherwise approval
  answers `429` and the draft stays pending for tomorrow

There is one draft per lead and touch: the first touch is `draft_<leadId>`, a follow-up is
`draft_<leadId>_touch2` and so on. When a new signal re-runs a lead, a pending draft for the
same touch is replaced with the new content, which has a new `contentHash`. If the lead no
longer gets a draft (say a demo request handed it to sales), its pending drafts are blocked. A draft
that was already sent is never replaced. Pending drafts are listed warmest first.

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

## Executive PDF brief

`npm run report:pdf` runs the pipeline and writes `reports/gtm-brief-procuros.pdf`: headline
metrics (leads processed, pass rate, enrichment cost, winning A/B variant), an outcome table for
every lead, and profiles of the top qualified prospects with their score, evidence, verified
buyer and outreach draft (or, for a lead handed to sales or queued, its next step). Leads held for manual review get a shorter profile: score, why they
were held, any missing data and the evidence. Pass `--out <path>` to write elsewhere.

The brief stays at 1-2 pages by profiling two leads: the highest-scoring qualified prospects
first, then held leads if a slot is free. Everyone else is in the outcome table. Runs on mock data carry a demo banner, and the A/B card only names a winner once
there is engagement data behind it. The layout code is in `src/shared/pdfReporter.ts`.

## Customize

Edit the files in `src/context/` to fit your market:

- `icp.json`: target industries, company size, countries, dealbreakers and scoring,
  including each signal type's warmth tier and points
- `routing.json`: which signals go straight to sales, and the daily outreach limit
- `personas.json`: buyer titles and pain points, in the order roles are tried
- `channels.json`: the first-touch and follow-up sequences, ad platforms, and the rules for
  which founder posts run as ads
- `voice.md`: tone and email rules, which drafts are checked against

## CI

- **CI** runs typecheck, tests, the offline demos and a webhook-server smoke test on every
  push and pull request.
- **Live qualification** runs `qualify:live` on demand. It needs an `ANTHROPIC_API_KEY`
  repository secret and spends a few API credits.

See `docs/reference-architecture-notes.md` for the design background, and
`docs/allbound-architecture-notes.md` for how the pipeline maps to an allbound (inbound + outbound) motion.
