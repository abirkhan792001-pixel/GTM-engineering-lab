import type { Touch } from '../shared/types';

// Which touches led to a booked meeting. Reads an account's CRM timeline (05_activation logs
// every engagement signal and every outbound touch there) and reports every touch before the
// conversion: the first, the last, and how many per channel. It is a multi-touch record for
// a person to read, not a weighting model: no touch gets fractional credit.

export interface Attribution {
  conversionAt: number;
  // Touches before the conversion, oldest first. The conversion itself is not one.
  touches: Touch[];
  firstTouch: Touch | null;
  lastTouch: Touch | null;
  // Counted separately: what we did (outbound) and how they engaged (inbound).
  byChannel: Record<Touch['direction'], Partial<Record<Touch['channel'], number>>>;
  daysFromFirstTouch: number | null;
}

const DAY_MS = 86_400_000;

export function attributeConversion(timeline: Touch[], conversionAt: number): Attribution {
  const touches = timeline
    .filter(t => t.at <= conversionAt && t.channel !== 'sales')
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const byChannel: Attribution['byChannel'] = { outbound: {}, inbound: {} };
  for (const t of touches) byChannel[t.direction][t.channel] = (byChannel[t.direction][t.channel] ?? 0) + 1;
  const firstTouch = touches[0] ?? null;
  return {
    conversionAt,
    touches,
    firstTouch,
    lastTouch: touches.at(-1) ?? null,
    byChannel,
    daysFromFirstTouch: firstTouch ? Math.round(((conversionAt - firstTouch.at) / DAY_MS) * 10) / 10 : null,
  };
}

// One line for logs and Slack.
export function describeAttribution(a: Attribution): string {
  if (!a.firstTouch) return 'Attribution: no touches logged before the meeting';
  const count = (direction: Touch['direction']) => Object.entries(a.byChannel[direction]).map(([channel, n]) => `${channel} ${n}`).join(', ') || 'none';
  return `Attribution: ${a.touches.length} touch(es) over ${a.daysFromFirstTouch} day(s); first ${a.firstTouch.kind} (${a.firstTouch.channel}), last ${a.lastTouch!.kind} (${a.lastTouch!.channel}); we reached them by ${count('outbound')}; they engaged by ${count('inbound')}`;
}
