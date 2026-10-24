import { ICP, type Icp } from './icp';
import type { Lead, Signal } from './types';

// The warmth ladder: how much a signal says about intent, from 5 (they raised their hand)
// down to 1 (we only have their data). A signal's tier and points come from its type in
// icp.json scoring.signals. The warmest fresh signal decides who gets contacted, who is
// addressed and who goes first.

export const WARMTH_TIERS: Record<number, string> = {
  5: 'hand-raise',
  4: 'engagement',
  3: 'trigger event',
  2: 'fit',
  1: 'data only',
};

const DAY_MS = 86_400_000;

export const signalTypeOf = (signal: Signal): string => (typeof signal.rawData.signalType === 'string' ? signal.rawData.signalType : 'unknown');

export function signalRule(type: string, icp: Icp = ICP): { tier: number; points: number } {
  return icp.scoring.signals[type] ?? icp.scoring.signals.default!;
}

export interface WarmSignal {
  signal: Signal;
  type: string;
  tier: number;
  tierName: string;
  ageDays: number;
}

// Signals inside the freshness window, warmest tier first, then newest first.
export function freshSignalsByWarmth(signals: Signal[], asOfMs: number, icp: Icp = ICP): WarmSignal[] {
  return signals
    .map(signal => {
      const type = signalTypeOf(signal);
      const { tier } = signalRule(type, icp);
      return { signal, type, tier, tierName: WARMTH_TIERS[tier]!, ageDays: (asOfMs - signal.timestamp) / DAY_MS };
    })
    .filter(w => w.ageDays >= 0 && w.ageDays <= icp.scoring.maxSignalAgeDays)
    .sort((a, b) => b.tier - a.tier || b.signal.timestamp - a.signal.timestamp);
}

export function warmestSignal(lead: Lead, asOfMs: number, icp: Icp = ICP): WarmSignal | null {
  return freshSignalsByWarmth(lead.signals, asOfMs, icp)[0] ?? null;
}
