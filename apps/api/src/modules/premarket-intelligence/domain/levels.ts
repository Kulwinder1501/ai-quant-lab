import type { CandidateLevel } from "./snapshot.js";
import type { PremarketInstrument } from "./targets.js";

export interface DailyBar {
  high: number;
  low: number;
  close: number;
}

/** How many prior sessions feed the multi-day high/low. */
export const RANGE_LOOKBACK_SESSIONS = 5;

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * The levels the model is allowed to choose among, computed from completed daily bars only.
 *
 * `priorSessions` is ordered oldest to newest and must not include the session being predicted --
 * the caller filters on date, so no level can contain information from the day it is meant to
 * anticipate. Returns an empty list when there is no prior session.
 *
 * Classic floor-trader pivots (P, R1, S1) plus the prior day's high/low/close and the prior
 * five-session range. They are widely watched, which is the only reason they are candidates; this
 * does not claim any of them has predictive value -- that is what the touch scoring measures.
 */
export function computeCandidateLevels(
  instrument: PremarketInstrument,
  priorSessions: readonly DailyBar[],
): CandidateLevel[] {
  const previous = priorSessions.at(-1);
  if (!previous) return [];

  const pivot = (previous.high + previous.low + previous.close) / 3;
  const recent = priorSessions.slice(-RANGE_LOOKBACK_SESSIONS);
  const levels: Array<{ key: string; label: string; price: number }> = [
    { key: "pdh", label: "Previous day high", price: previous.high },
    { key: "pdl", label: "Previous day low", price: previous.low },
    { key: "pdc", label: "Previous day close", price: previous.close },
    { key: "pivot", label: "Classic pivot (prior day)", price: pivot },
    { key: "r1", label: "Classic R1 (prior day)", price: 2 * pivot - previous.low },
    { key: "s1", label: "Classic S1 (prior day)", price: 2 * pivot - previous.high },
  ];
  if (recent.length >= 2) {
    levels.push(
      { key: "range-high", label: `${recent.length}-session high`, price: Math.max(...recent.map((bar) => bar.high)) },
      { key: "range-low", label: `${recent.length}-session low`, price: Math.min(...recent.map((bar) => bar.low)) },
    );
  }

  return levels
    .filter((level) => Number.isFinite(level.price) && level.price > 0)
    .map((level) => ({
      id: `level-${instrument.toLowerCase()}-${level.key}`,
      instrument,
      label: level.label,
      price: rounded(level.price),
    }));
}
