import { recipientGap, sendableEmail } from '../04_contacts/index';
import { CHANNELS, type ChannelsConfig } from '../shared/channels';
import { ICP, type Icp } from '../shared/icp';
import type { AdPlatform, AudienceMembership, ChannelPlan, ChannelStep, Lead, Signal, Touch } from '../shared/types';
import { freshSignalsByWarmth, signalTypeOf } from '../shared/warmth';

// Allbound layers 3-5: run every channel on the same people, capture engagement, follow up.
//
//   planSteps()       the sequence for this contact (channels.json): email, LinkedIn and call
//                     steps, each planned only when we have a way to reach them. No verified
//                     email means LinkedIn steps only; no phone means no call.
//   planAudiences()   the ad audiences the account joins: LinkedIn by company domain, Google and
//                     Meta by verified email. Accounts that engaged after a touch also join
//                     the retargeting audience, so ads and outreach follow up at the same time.
//   touchForSignal()  which engagement signals belong on the CRM timeline, and on what channel.
//   newEngagement()   engagement signals that arrived after our last email: the follow-up trigger.
//   selectPostsToPromote()  the founder posts worth running as ads.

export type PlanMode = ChannelPlan['mode'];

export function planSteps(lead: Lead, mode: PlanMode, asOfMs: number, config: ChannelsConfig = CHANNELS): ChannelStep[] {
  const person = lead.contact?.person ?? null;
  const email = sendableEmail(lead, asOfMs);
  const steps = mode === 'first_touch' ? config.firstTouch : config.followUp;
  const signOff = 'Sequencer step: a person signs off before it reaches the prospect';

  return steps.map(({ day, channel, action }): ChannelStep => {
    const skip = (reason: string): ChannelStep => ({ day, channel, action, status: 'skipped', target: null, reason });
    if (!person) return skip(lead.contact?.reason ?? 'No contact found at the account');
    switch (channel) {
      case 'email':
        if (!email) return skip(lead.contact?.status === 'verified' ? (recipientGap(lead, asOfMs) ?? 'No verified email') : `No verified email (${lead.contact?.emailStatus ?? 'none found'})`);
        return { day, channel, action, status: 'planned', target: email, reason: day === 0 ? 'The draft awaiting approval' : signOff };
      case 'linkedin':
        return person.linkedinUrl ? { day, channel, action, status: 'planned', target: person.linkedinUrl, reason: signOff } : skip(`No LinkedIn profile for ${person.fullName}`);
      case 'call':
        return person.phone ? { day, channel, action, status: 'planned', target: person.phone, reason: signOff } : skip(`No phone number for ${person.fullName}`);
    }
  });
}

export interface AudienceIntent {
  platform: AdPlatform;
  audience: AudienceMembership['audience'];
  match: AudienceMembership['match'];
  // Null when the platform can't match this account (e.g. no verified email for Google or Meta).
  value: string | null;
  skipReason: string | null;
}

export function planAudiences(lead: Lead, mode: PlanMode, asOfMs: number, config: ChannelsConfig = CHANNELS): AudienceIntent[] {
  const email = sendableEmail(lead, asOfMs);
  const audiences: AudienceMembership['audience'][] = mode === 'follow_up' ? ['icp-accounts', 'engager-retargeting'] : ['icp-accounts'];
  return audiences.flatMap(audience =>
    config.adPlatforms.map((platform): AudienceIntent =>
      platform === 'linkedin'
        ? { platform, audience, match: 'company', value: lead.companyDomain, skipReason: null }
        : { platform, audience, match: 'email', value: email, skipReason: email ? null : 'No verified email to match on' },
    ),
  );
}

// Engagement signals go on the CRM timeline as inbound touches. List sourcing and hiring
// posts are research, not engagement with us, so they are left off.
const SIGNAL_TOUCH_CHANNELS: Record<string, Touch['channel']> = {
  'demo-request': 'web',
  'contact-form': 'web',
  signup: 'web',
  'pricing-page-visit': 'web',
  'email-reply': 'email',
  'linkedin-reply': 'linkedin',
  'linkedin-own-post-engagement': 'linkedin',
  'linkedin-competitor-post-engagement': 'linkedin',
  'linkedin-profile-view': 'linkedin',
  'linkedin-company-follow': 'linkedin',
  'ad-click': 'ads',
  'meeting-booked': 'sales',
};

export function touchForSignal(lead: Lead, signal: Signal): Touch | null {
  const kind = signalTypeOf(signal);
  const channel = SIGNAL_TOUCH_CHANNELS[kind];
  if (!channel) return null;
  const who = typeof signal.rawData.contactName === 'string' ? ` by ${signal.rawData.contactName}` : '';
  const platform = typeof signal.rawData.adPlatform === 'string' ? ` on ${signal.rawData.adPlatform}` : '';
  return { id: `touch_${signal.id}`, companyDomain: lead.companyDomain, at: signal.timestamp, direction: 'inbound', channel, kind, detail: `${kind}${who}${platform} via ${signal.source}` };
}

// Fresh engagement (tier 4 and up, i.e. it engaged with us or our content) newer than `afterMs`.
export function newEngagement(lead: Lead, afterMs: number, asOfMs: number, icp: Icp = ICP): Signal[] {
  return freshSignalsByWarmth(lead.signals, asOfMs, icp)
    .filter(w => w.tier >= 4 && w.signal.timestamp > afterMs && touchForSignal(lead, w.signal))
    .map(w => w.signal);
}

// ---------------------------------------------------------------------------
// Founder posts -> ads
// ---------------------------------------------------------------------------

export interface FounderPost {
  id: string;
  author: string;
  publishedAt: number;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
}

export interface PostDecision {
  post: FounderPost;
  engagementRatePct: number;
  reason: string;
}

// The best recent posts by engagement rate, capped at maxPostsToPromote. Every post that is
// not promoted says why (too old, too few impressions to trust the rate, rate too low, or
// over the cap), so a person can overrule the pick.
export function selectPostsToPromote(posts: FounderPost[], asOfMs: number, config: ChannelsConfig = CHANNELS): { promote: PostDecision[]; hold: PostDecision[] } {
  const rules = config.founderPostAds;
  const rate = (p: FounderPost) => (p.impressions === 0 ? 0 : Math.round(((p.reactions + p.comments + p.reposts) / p.impressions) * 1000) / 10);
  const hold: PostDecision[] = [];
  const eligible: PostDecision[] = [];

  for (const post of posts) {
    const engagementRatePct = rate(post);
    const ageDays = (asOfMs - post.publishedAt) / 86_400_000;
    const reason =
      ageDays < 0 || ageDays > rules.maxAgeDays ? `Published ${Math.round(ageDays)} day(s) ago; only posts from the last ${rules.maxAgeDays} days run as ads`
      : post.impressions < rules.minImpressions ? `${post.impressions} impressions; needs ${rules.minImpressions} before the rate means anything`
      : engagementRatePct < rules.minEngagementRatePct ? `Engagement rate ${engagementRatePct}% is under ${rules.minEngagementRatePct}%`
      : null;
    if (reason) hold.push({ post, engagementRatePct, reason });
    else eligible.push({ post, engagementRatePct, reason: `Engagement rate ${engagementRatePct}% on ${post.impressions} impressions` });
  }

  eligible.sort((a, b) => b.engagementRatePct - a.engagementRatePct || b.post.impressions - a.post.impressions || a.post.id.localeCompare(b.post.id));
  const promote = eligible.slice(0, rules.maxPostsToPromote);
  for (const d of eligible.slice(rules.maxPostsToPromote)) hold.push({ ...d, reason: `${d.reason}; over the limit of ${rules.maxPostsToPromote} promoted posts` });
  return { promote, hold };
}
