/**
 * Where today's implied volatility sits against its own history.
 *
 * Factor 5 of the pre-trade checklist asks whether IV is high *relative to itself*, and until
 * now there was no answer at all. There still is not much of one — chain snapshots begin
 * 2026-08-04 and the series cannot be backfilled, because a chain endpoint returns the current
 * book and no historical source exists. What this adds is the machinery plus an honest
 * refusal, so the answer appears on its own as history accumulates instead of waiting on
 * someone to notice it is now possible.
 *
 * The percentile is computed over **one value per day**. Fifteen-minute snapshots are heavily
 * autocorrelated — 25 observations from one session are one day's information, not 25
 * independent samples — so ranking against raw observations would report a confident
 * percentile built from a couple of days and be wrong in the direction that matters: it would
 * call an ordinary IV extreme.
 */

export const MINIMUM_DISTINCT_DAYS = 20;

export interface DailyImpliedVolatility {
  /** Calendar day, `YYYY-MM-DD`. One entry per day. */
  date: string;
  impliedVolatility: number;
}

export type IvPercentileResult =
  | {
    measurable: true;
    /** 0-100: the share of historical days whose IV was below the current reading. */
    percentile: number;
    currentImpliedVolatility: number;
    observedDays: number;
    lowestImpliedVolatility: number;
    highestImpliedVolatility: number;
  }
  | {
    measurable: false;
    reason: "INSUFFICIENT_HISTORY" | "NO_CURRENT_READING";
    explanation: string;
    observedDays: number;
    requiredDays: number;
  };

/**
 * Ranks `current` against the daily history.
 *
 * Refuses rather than extrapolating from a short series. A percentile over three days is
 * arithmetically fine and analytically worthless, and this project has already paid for
 * numbers that looked computed but meant nothing.
 */
export function summariseIvPercentile(input: {
  history: readonly DailyImpliedVolatility[];
  currentImpliedVolatility: number | null;
  minimumDays?: number;
}): IvPercentileResult {
  const requiredDays = input.minimumDays ?? MINIMUM_DISTINCT_DAYS;

  // One value per day, newest wins, so a caller passing several readings for a date cannot
  // weight that day more heavily than the others.
  const byDate = new Map<string, number>();
  for (const entry of input.history) {
    if (!Number.isFinite(entry.impliedVolatility) || entry.impliedVolatility <= 0) continue;
    byDate.set(entry.date, entry.impliedVolatility);
  }
  const values = [...byDate.values()].sort((left, right) => left - right);
  const observedDays = values.length;

  if (input.currentImpliedVolatility === null
    || !Number.isFinite(input.currentImpliedVolatility)
    || input.currentImpliedVolatility <= 0) {
    return {
      measurable: false,
      reason: "NO_CURRENT_READING",
      explanation: "No ATM implied volatility could be solved from the current chain, so there "
        + "is nothing to rank against history.",
      observedDays,
      requiredDays,
    };
  }

  if (observedDays < requiredDays) {
    return {
      measurable: false,
      reason: "INSUFFICIENT_HISTORY",
      explanation: `An IV percentile needs at least ${requiredDays} distinct days; `
        + `${observedDays} ${observedDays === 1 ? "is" : "are"} stored. Option-chain history is `
        + "forward-accumulating and cannot be backfilled, so this resolves with time.",
      observedDays,
      requiredDays,
    };
  }

  const below = values.filter((value) => value < input.currentImpliedVolatility!).length;
  return {
    measurable: true,
    // Share strictly below, so an IV equal to every stored day reads as 0 rather than 100 --
    // "never been higher" is a claim that needs a day it exceeded.
    percentile: (below / observedDays) * 100,
    currentImpliedVolatility: input.currentImpliedVolatility,
    observedDays,
    lowestImpliedVolatility: values[0]!,
    highestImpliedVolatility: values[observedDays - 1]!,
  };
}
