/**
 * Per-strategy clock for the O1 exit state machine.
 *
 * The O1 machine was calibrated for the 1-minute scalp and the sniper: "no 0.30R of progress within
 * 15 minutes" is a sensible verdict on a trade that is supposed to resolve in minutes. It is the
 * wrong verdict on `ict-structure-v1`, whose setups are 5m/15m structure trades that target up to
 * 3R. On a 15m chart 15 minutes is ONE bar: the trade was judged before the next bar could print,
 * and a normal pullback after entry was indistinguishable from failure. (Found 2026-10-09: the
 * first NIFTY 15m ICT trade was ended by TIME_STOP 15 minutes after entry, 10.7 points against.)
 *
 * The rule here is deliberately structural rather than tuned: an ICT trade gets `ICT_TIME_STOP_BARS`
 * bars of its own timeframe to show progress. That is a scale correction (minutes -> bars), not an
 * optimisation against any P&L, which is why it is applied without a separate measurement. Strategies
 * that are not listed keep the 15-minute behaviour exactly.
 */

export interface O1ExitTimings {
  readonly timeStopMinutes: number;
  readonly premiumToleranceMinutes: number;
}

export const DEFAULT_O1_EXIT_TIMINGS: O1ExitTimings = {
  timeStopMinutes: 15,
  premiumToleranceMinutes: 10,
};

export const ICT_TIME_STOP_BARS = 4;

const TIMEFRAME_MINUTES: Readonly<Record<string, number>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "10m": 10,
  "15m": 15,
  "30m": 30,
  "1h": 60,
};

export function resolveO1ExitTimings(
  strategyKey: string | null | undefined,
  timeframe: string | null | undefined,
): O1ExitTimings {
  if (strategyKey !== "ict-structure-v1" || !timeframe) return DEFAULT_O1_EXIT_TIMINGS;
  const barMinutes = TIMEFRAME_MINUTES[timeframe];
  if (barMinutes === undefined) return DEFAULT_O1_EXIT_TIMINGS;

  // Never shorter than the legacy clock; scales the legacy 15:10 ratio so both rules stretch together.
  const timeStopMinutes = Math.max(DEFAULT_O1_EXIT_TIMINGS.timeStopMinutes, ICT_TIME_STOP_BARS * barMinutes);
  const premiumToleranceMinutes =
    (timeStopMinutes / DEFAULT_O1_EXIT_TIMINGS.timeStopMinutes) * DEFAULT_O1_EXIT_TIMINGS.premiumToleranceMinutes;
  return { timeStopMinutes, premiumToleranceMinutes };
}
