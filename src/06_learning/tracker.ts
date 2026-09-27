import { z } from 'zod';
import { assignVariant, FIRST_TOUCH_EXPERIMENT, VariantIdSchema, type Experiment, type VariantId } from './experiments';

// In-memory engagement store and experiment analytics.
// Counting rules:
//   - Each event type counts once per lead (a second open is not a second opener).
//   - Outcomes only count for leads with a 'sent' event in the same variant; anything
//     else is reported as an orphan, never silently added to a rate.
//   - Rates use sends as the denominator.
//   - A lead's events must all carry the variant assignVariant() gives it; a mismatch
//     means the treatment changed mid-round and the event is rejected.

export const EngagementEventTypeSchema = z.enum(['sent', 'opened', 'replied', 'meeting_booked', 'bounced']);
export type EngagementEventType = z.infer<typeof EngagementEventTypeSchema>;

export const EngagementEventSchema = z.strictObject({
  leadId: z.string().trim().min(1),
  variantId: VariantIdSchema,
  eventType: EngagementEventTypeSchema,
  timestamp: z.iso.datetime(),
});
export type EngagementEvent = z.infer<typeof EngagementEventSchema>;

export interface VariantMetrics {
  variantId: VariantId;
  sends: number;
  bounced: number;
  opened: number;
  replied: number;
  meetingsBooked: number;
  openRate: number; // percentages of sends, 0-100, 1 decimal
  replyRate: number;
  meetingRate: number;
  orphanEvents: number;
}

export interface ExperimentMetrics {
  experimentId: string;
  variants: VariantMetrics[];
  winner: VariantId | null;
  winnerBasis: string;
  enoughData: boolean;
  note: string;
}

export type TrackResult = { accepted: true } | { accepted: false; reason: 'duplicate' };

const percent = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 1000) / 10);

export function createEventStore(experiment: Experiment = FIRST_TOUCH_EXPERIMENT) {
  const events: EngagementEvent[] = [];
  const seen = new Set<string>();

  function trackEvent(input: unknown): TrackResult {
    const event = EngagementEventSchema.parse(input);
    const assigned = assignVariant(event.leadId, experiment).id;
    if (event.variantId !== assigned) {
      throw new Error(`Event for ${event.leadId} carries ${event.variantId}, but the lead is assigned ${assigned} in ${experiment.id}`);
    }
    const key = `${event.leadId}|${event.eventType}|${event.timestamp}`;
    if (seen.has(key)) return { accepted: false, reason: 'duplicate' };
    seen.add(key);
    events.push(event);
    return { accepted: true };
  }

  function getExperimentMetrics(): ExperimentMetrics {
    const variants = experiment.variants.map(({ id }): VariantMetrics => {
      const leadsWith = (type: EngagementEventType) =>
        new Set(events.filter(e => e.variantId === id && e.eventType === type).map(e => e.leadId));
      const sent = leadsWith('sent');
      const outcome = (type: EngagementEventType) => [...leadsWith(type)].filter(lead => sent.has(lead)).length;
      const orphanEvents = events.filter(e => e.variantId === id && e.eventType !== 'sent' && !sent.has(e.leadId)).length;
      const sends = sent.size;
      const opened = outcome('opened');
      const replied = outcome('replied');
      const meetingsBooked = outcome('meeting_booked');
      return {
        variantId: id,
        sends,
        bounced: outcome('bounced'),
        opened,
        replied,
        meetingsBooked,
        openRate: percent(opened, sends),
        replyRate: percent(replied, sends),
        meetingRate: percent(meetingsBooked, sends),
        orphanEvents,
      };
    });

    const { winner, winnerBasis } = pickWinner(variants);
    const enoughData = variants.every(v => v.sends >= experiment.minSendsPerVariant);
    const sendCounts = variants.map(v => v.sends).join('/');
    const note = enoughData
      ? `Every variant reached ${experiment.minSendsPerVariant} sends. This is a review floor, not a significance test.`
      : `Insufficient data: ${sendCounts} sends vs a minimum of ${experiment.minSendsPerVariant} per variant. Treat the leader as directional only.`;
    return { experimentId: experiment.id, variants, winner, winnerBasis, enoughData, note };
  }

  return { events, trackEvent, getExperimentMetrics };
}

// Conversion = meeting-booked rate (the experiment's primary metric); reply rate breaks ties.
function pickWinner(variants: VariantMetrics[]): { winner: VariantId | null; winnerBasis: string } {
  const [a, b] = variants;
  if (!a || !b || a.sends === 0 || b.sends === 0) return { winner: null, winnerBasis: 'Every variant needs at least one send' };
  const fmt = (v: VariantMetrics, key: 'meetingRate' | 'replyRate') => `${v.variantId} ${v[key].toFixed(1)}%`;
  if (a.meetingRate !== b.meetingRate) {
    const [win, lose] = a.meetingRate > b.meetingRate ? [a, b] : [b, a];
    return { winner: win.variantId, winnerBasis: `meeting-booked rate: ${fmt(win, 'meetingRate')} vs ${fmt(lose, 'meetingRate')}` };
  }
  if (a.replyRate !== b.replyRate) {
    const [win, lose] = a.replyRate > b.replyRate ? [a, b] : [b, a];
    return { winner: win.variantId, winnerBasis: `meeting rates tied; reply rate: ${fmt(win, 'replyRate')} vs ${fmt(lose, 'replyRate')}` };
  }
  return { winner: null, winnerBasis: 'Tie on meeting-booked and reply rate' };
}

// Default store for callers that want module-level functions.
const defaultStore = createEventStore();
export const trackEvent = defaultStore.trackEvent;
export const getExperimentMetrics = defaultStore.getExperimentMetrics;
