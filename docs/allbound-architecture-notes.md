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

| Layer | Our equivalent | Status |
|---|---|---|
| 1 Source | `01_signals`: mock signals and the webhook intake (`intake.ts`), with `normalizeDomain()` | **Partial.** We take intent signals one at a time. There's no list sourcing from databases, and no dedupe across signals: two webhooks for the same domain create two leads (`server.ts` mints a new lead id per signal). |
| 2 Qualify: ICP | `03_qualification`: dealbreaker rules, then Claude scores with evidence; failures and gaps are held | **Done.** Same pattern as theirs: the agent gives reasons, code makes the call, and no fit means hold. |
| 2 Qualify: persona | `04_contacts` `pickBuyer()` tries the persona sized for the account, then the others | **Done in shape.** Our personas are RevOps and founders. Theirs are Demand Gen, VP Marketing and CRO, which is a change to `personas.json`, not to code. |
| 2 Qualify: email | `04_contacts`: one email finder plus verification | **Partial.** It's a single provider, not a waterfall, and without a verified email we stop. They fall back to a LinkedIn-only sequence. |
| 3 Channels | `05_activation`: one email draft per lead, approved by a human before sending | **Email only.** No ads audiences, LinkedIn steps, calls or content-to-ads loop. |
| 4 Signal capture | `06_learning` `createEventStore()`: sent, opened, replied, meeting booked, bounced | **Partial.** The events are email-only and serve the A/B test. They don't flow back into `01_signals` as new intent. |
| 5 Follow-up + CRM | `05_activation` mock CRM `syncContact()`, Slack alert | **Partial.** The CRM write happens once, at first activation. There's no follow-up on engagement, no retargeting, and no touch-level attribution. The CRM has no live adapter yet. |

## The main structural difference

Our pipeline is a **line**: signal → enrich → qualify → contact → one email → measure. Allbound is
a **loop**. Engagement on any channel is a new signal on an account we already know, and it should
update that account and trigger the next touch, not create a new lead. Most of the gaps above come
from that one difference, so it's the first thing to change.

## What to borrow, in order

1. **Account-level dedupe at intake.** Key leads by `companyDomain` and append new signals to the
   existing lead instead of minting a new one. This prepares for layer 1 (multi-source lists) and
   is required for layer 4 (engagement as signals).
2. **Engagement as signals.** Widen the event types beyond email (`post_engaged`,
   `profile_viewed`, `dm_replied`, `ad_clicked`) and route them through `01_signals` onto the
   existing account. The A/B store can keep reading the subset it needs.
3. **Email waterfall with a fallback channel.** Make `EmailFinderProvider` a list that's tried in
   order, stopping at the first `valid`, with cost per step already tracked in `steps[]`. When
   nothing verifies, mark the contact `linkedin_only` instead of stopping.
4. **Channel plan in activation.** Have activation produce a per-contact plan (email draft,
   LinkedIn steps, ads-audience membership) rather than a single draft. The human approval gate
   stays on anything sent to a person.
5. **Touch log for attribution.** Record every touch and engagement against the CRM contact with
   channel and timestamp, so a booked meeting can be traced to the touches before it.
6. **Persona set for a marketing-led ICP.** Add Demand Gen, VP Marketing and CRO personas if we
   target the same buyer. This is config only.

Out of scope for now: buying ads and running a sequencer. Like the reference template in
`reference-architecture-notes.md`, we'd hand those off to a platform (OXYGEN, ad networks via
an audience sync) and own only the data, the gates and the attribution.
