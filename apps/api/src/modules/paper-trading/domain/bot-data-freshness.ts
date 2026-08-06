/**
 * Whether the market data behind a signal is fresh enough to act on.
 *
 * The bot filled from "the latest complete 1m candle" with no freshness test at all. On
 * 2026-08-06 that candle was 05 Aug for NIFTY50 and **31 July** for BANKNIFTY, because Fyers
 * had published no intraday data for either since. A signal generated from a six-day-old
 * price is not a stale signal, it is a fictional one, and nothing in the pipeline would have
 * said so.
 *
 * Kept separate from the CLI so the rule is testable without a database.
 */

export type DataFreshness =
  | { fresh: true; ageMinutes: number }
  | { fresh: false; reason: "NO_DATA" | "STALE"; ageMinutes: number | null; explanation: string };

/** One trading day. Anything older than a session cannot describe the current market. */
export const DEFAULT_MAX_BAR_AGE_MINUTES = 15;

export function assessDataFreshness(input: {
  symbol: string;
  latestBarCloseTime: Date | null;
  now: Date;
  maxAgeMinutes?: number;
}): DataFreshness {
  const maxAge = input.maxAgeMinutes ?? DEFAULT_MAX_BAR_AGE_MINUTES;

  if (input.latestBarCloseTime === null || Number.isNaN(input.latestBarCloseTime.getTime())) {
    return {
      fresh: false,
      reason: "NO_DATA",
      ageMinutes: null,
      explanation: `${input.symbol} has no stored bar to price a signal from.`,
    };
  }

  const ageMinutes = (input.now.getTime() - input.latestBarCloseTime.getTime()) / 60_000;
  // A bar closing in the future is a clock or timezone fault, not freshness. Treated as
  // unusable rather than "very fresh", which is what a negative age would otherwise mean.
  if (ageMinutes < 0) {
    return {
      fresh: false,
      reason: "STALE",
      ageMinutes,
      explanation: `${input.symbol}'s latest bar closes in the future `
        + `(${input.latestBarCloseTime.toISOString()}), which is a clock fault rather than data.`,
    };
  }
  if (ageMinutes > maxAge) {
    return {
      fresh: false,
      reason: "STALE",
      ageMinutes,
      explanation: `${input.symbol}'s latest bar closed ${Math.round(ageMinutes)} minutes ago, `
        + `past the ${maxAge}-minute limit. Collection has probably stopped; acting on it would `
        + "price a signal against a market that has moved on.",
    };
  }
  return { fresh: true, ageMinutes };
}
