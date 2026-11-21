# Allbound architecture notes: Understory × OXYGEN

Source: a LinkedIn post by Tim Scheuer (OXYGEN) about a live build with Ali Yildirim, Alex Fine
and Imran Izham (Understory). They built it with Claude Code in under 30 minutes.

**In one line:** allbound runs inbound and outbound as one motion. The same accounts get ads,
sequences and founder content at the same time. Every engagement, from any channel, goes back into
one signal store and drives the next follow-up. Their reasoning is that rising CAC means marketing
and sales can't run as separate funnels.

## The 5 layers

| # | Layer | What they do |
|---|---|---|
| 1 | Source | Pull accounts from BlitzAPI, Sales Navigator, Prospeo, AI Ark and Ocean.io, then dedupe them. (The pasted post dropped this layer's heading; "Source" is inferred.) |
| 2 | Qualify | An agent scores ICP fit with reasons; no fit, hold the account. Look for Demand Gen, VP Marketing or CRO; wrong persona, try the next role. Run an email waterfall and verify; no email, LinkedIn steps only. |
| 3 | Run 3 channels on the same people | Ads on LinkedIn, Google and Meta. OXYGEN Sequencer for email, LinkedIn and cold calls. Founders post weekly, and the best posts run as ads. |
| 4 | Capture every signal in 1 place | Fibbler for ad engagement, plus replies, post engagers, profile viewers and DMs. |
| 5 | Follow up, then log it in the CRM | Reach out to engagers on LinkedIn and email while retargeting them with ads. Sync everything to the CRM for attribution. |

## How our pipeline maps

Status as of the allbound build (`npm run allbound:dev` runs all five layers offline).

| Layer | Where it lives | Status |
|---|---|---|
| 1 Source | `01_signals/sourcing.ts`: `sourceAccounts()` over `AccountListProvider`s, then `mergeByDomain()` | **Built, on mocks.** Five mock lists (BlitzAPI, Sales Navigator, Prospeo, AI Ark, Ocean.io) with overlapping, messy domains. Each listing is an `account-list` signal (tier 2), so one account found by three lists is one lead with three signals. |
| 2 Qualify: ICP | `03_qualification` | **Built.** The agent gives reasons and code makes the call; a poor fit is held. |
| 2 Qualify: persona | `04_contacts` `pickBuyer()` + `personas.json` | **Built.** Tries the persona sized for the account, then the next role. Demand Gen / VP Marketing and CRO / VP Sales are fallback personas. |
| 2 Qualify: email | `04_contacts` waterfall (`emailFinders`) | **Built, on mocks.** Providers are tried in order until one returns a valid address, and each is a priced step. No valid email plus a known LinkedIn profile means LinkedIn steps only. |
| 3 Channels | `05_activation/channels.ts`, `channels.json`, `adapters/mockAudiences.ts` | **Built as a plan, on mocks.** Email, LinkedIn and call steps, each planned only where the contact can be reached. The account joins ad audiences: LinkedIn by company, Google and Meta by hashed verified email. `selectPostsToPromote()` picks founder posts to run as ads. |
| 4 Signal capture | `01_signals/intake.ts`, plus the CRM timeline in `adapters/mockCRM.ts` | **Built.** Replies, LinkedIn DMs, ad clicks (`ad_click` + `adPlatform`, e.g. from Fibbler), LinkedIn engagement and booked meetings arrive at one webhook and land on the account's lead. Engagement signals, sent emails and ad audience joins are all logged on one timeline. |
| 5 Follow-up + CRM | `05_activation/index.ts`, `approvals.ts`, `06_learning/attribution.ts` | **Built.** Engagement after a sent email produces a follow-up draft (touch 2, 3, …) and puts the account in the retargeting audiences, at the same time. With nothing new, the lead is `in_sequence`. A booked meeting goes to sales with multi-touch attribution. `GET /api/accounts/:domain/timeline` serves the timeline. |

## The main structural difference, now closed

Our pipeline used to be a **line**: signal → enrich → qualify → contact → one email → measure.
It is now a **loop**. Engagement on any channel is a new signal on an account we already know.
The account's CRM timeline then decides the next step: a first touch, a follow-up with
retargeting, waiting, or sales.

## Still not live

These run on mocks. Each needs an adapter that implements the existing interface:

- **List providers** (`AccountListProvider`): BlitzAPI, Sales Navigator, Prospeo, AI Ark, Ocean.io.
- **Email waterfall** (`EmailFinderProvider`): the real providers and their verification.
- **Ad audiences** (`AudienceAdapter`): LinkedIn Matched Audiences, Google Customer Match and
  Meta Custom Audiences. Uploading personal data to ad platforms needs a lawful basis and an
  opt-out path; the suppression check already runs before any audience join.
- **Sequencer**: the channel plan is data. Nothing here sends LinkedIn messages or places
  calls. A sequencer such as OXYGEN would run the planned steps after a person signs off.
  Only the email step is sent from this repo, through the approval queue.
- **Phone numbers**: the call step needs a phone on the contact. No mock or live source
  provides one except the demo CRO.
- **CRM**: touches live in the mock CRM's memory. A live Attio/HubSpot adapter would write
  them as activities on the company record.
- **Ad engagement feed**: `ad_click` is the intake shape. A live Fibbler (or similar)
  integration would post to the webhook.

Running ads and a sequencer remain out of scope. Like the reference template in
`reference-architecture-notes.md`, we hand those off to a platform and own only the data, the
gates and the attribution.
