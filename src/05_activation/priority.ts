import { ICP, type Icp } from '../shared/icp';
import { ROUTING, type Routing } from '../shared/routing';
import type { Lead } from '../shared/types';
import { freshSignalsByWarmth, warmestSignal, type WarmSignal } from '../shared/warmth';

// Who gets the first message.
//   - A qualified lead with a fresh hand-to-sales signal (routing.json, e.g. a demo request)
//     skips outreach: they asked to talk, so sales replies personally instead of a sequence.
//   - Every other qualified lead is ranked by its warmest fresh signal's tier, then ICP
//     score, then how recent that signal is. The top dailyOutreachLimit get drafts; the rest
//     are queued with their rank and reason, never silently dropped.

export interface PriorityOptions {
  asOfMs: number;
  icp?: Icp;
  routing?: Routing;
}

// The fresh signal that hands this lead to sales, or null.
export function salesHandoffSignal(lead: Lead, { asOfMs, icp = ICP, routing = ROUTING }: PriorityOptions): WarmSignal | null {
  return freshSignalsByWarmth(lead.signals, asOfMs, icp).find(w => routing.routeToSalesSignals.includes(w.type)) ?? null;
}

// Outreach order: warmest tier, then ICP score, then the freshest warmest signal; lead id breaks ties.
export function compareForOutreach(a: Lead, b: Lead, { asOfMs, icp = ICP }: PriorityOptions): number {
  const warmA = warmestSignal(a, asOfMs, icp);
  const warmB = warmestSignal(b, asOfMs, icp);
  return (
    (warmB?.tier ?? 0) - (warmA?.tier ?? 0) ||
    (b.qualification?.score ?? 0) - (a.qualification?.score ?? 0) ||
    (warmB?.signal.timestamp ?? 0) - (warmA?.signal.timestamp ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

export type OutreachLane = 'sales' | 'outreach' | 'queued' | 'not_qualified';

export interface OutreachSlot {
  leadId: string;
  lane: OutreachLane;
  // Position among the leads competing for outreach (outreach and queued lanes only).
  rank: number | null;
  reason: string;
}

// Plans one batch, in the order leads should be activated: sales handoffs, then outreach by
// rank, then the queue, then leads that did not pass qualification.
export function planOutreach(leads: Lead[], options: PriorityOptions & { limit?: number }): OutreachSlot[] {
  const routing = options.routing ?? ROUTING;
  const limit = options.limit ?? routing.dailyOutreachLimit;
  const passing = leads.filter(lead => lead.qualification?.decision === 'pass');

  const sales: OutreachSlot[] = [];
  const contenders: Lead[] = [];
  for (const lead of passing) {
    const handoff = salesHandoffSignal(lead, options);
    if (handoff) sales.push({ leadId: lead.id, lane: 'sales', rank: null, reason: `Fresh ${handoff.type} signal: hand to sales for a personal reply, no sequence` });
    else contenders.push(lead);
  }

  const ranked = contenders.sort((a, b) => compareForOutreach(a, b, options)).map((lead, i): OutreachSlot => {
    const rank = i + 1;
    const warm = warmestSignal(lead, options.asOfMs, options.icp);
    const why = warm ? `tier ${warm.tier} (${warm.tierName}) ${warm.type} signal` : 'no fresh signal';
    const position = `Priority ${rank} of ${contenders.length}: ${why}, score ${lead.qualification!.score}`;
    return rank <= limit
      ? { leadId: lead.id, lane: 'outreach', rank, reason: position }
      : { leadId: lead.id, lane: 'queued', rank, reason: `${position}; over the daily outreach limit of ${limit}, queued for the next run` };
  });

  const rest = leads
    .filter(lead => lead.qualification?.decision !== 'pass')
    .map((lead): OutreachSlot => ({ leadId: lead.id, lane: 'not_qualified', rank: null, reason: `Qualification decision: ${lead.qualification?.decision ?? 'none'}` }));

  return [...sales, ...ranked, ...rest];
}
