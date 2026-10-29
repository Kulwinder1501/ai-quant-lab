import { XAUUSD_OANDA_PROFILE, sessionDateKey, type InstrumentProfile } from "../../../platform/calendar/instrument-profile.js";

/**
 * Data-gap guard for the ICT engine.
 *
 * The engine reads a series by index, so two consecutive bars in it may be hours apart without it
 * noticing: a pivot's wings, a session's high and low and a fair-value gap are all computed as if the
 * bars were adjacent. For gold that is not hypothetical. The host sleeps overnight, the 15-minute
 * collection only ever fetches the last 45 minutes, and the hourly heal fills the rest later, so every
 * morning's first snapshots were computed over a series with the whole New York afternoon missing:
 * measured 2026-10-29, 27% of the 02:55-04:00 UTC snapshots since 10-12 carried a wrong prior-day
 * high, low or close (up to $22 off), and each said `COMPLETE`.
 *
 * A gap is the part of a hole between two consecutive bars that falls inside the instrument's own open
 * hours. The weekend close and the daily New York break are not gaps, which is why the guard needs the
 * instrument profile and is only built for an instrument whose profile knows its calendar (gold).
 * NSE instruments get no guard, so their snapshots and cache identity are exactly what they were.
 *
 * What it does not know: market holidays. Gold's profile has no holiday calendar, so a US holiday
 * closure reads as a gap (28 of them in 2.8 years of 5m data, almost every one of 30 minutes or more).
 * That is accepted: those sessions are thin, and the cost is that the ICT pillars stay unavailable for
 * a short while after them.
 */
export interface IctGapGuard {
  /** The timeframe's bar length. */
  readonly barMinutes: number;
  /** A hole of at least this many minutes inside the open hours is a data gap; shorter ones are tolerated. */
  readonly minGapMinutes: number;
  /** How many bars after a gap structure and zones stay unreliable. */
  readonly recoveryBars: number;
}

/**
 * Sixty minutes, because it ignores the small systematic holes in the derived 15m series around the daily break (30 to 45 minutes,
 * every day) and the odd missing minute, and still catches the multi-hour holes this exists for. Not tuned on outcomes: of the
 * unexpected gaps in gold's 5m history since 2024, the ones of 30 minutes or more are almost all holiday closures.
 */
export const GOLD_MIN_GAP_MINUTES = 60;

/**
 * Thirty-six bars: three hours on 5m, nine on 15m. Long enough to cover the bars the morning's first snapshots are computed over
 * before the heal fills the hole, and short enough that a holiday closure does not block structure for long. A judgment.
 */
export const GOLD_RECOVERY_BARS = 36;

/** The guard for an instrument and timeframe, or null where there is none (every NSE instrument, and any timeframe label it cannot read). */
export function ictGapGuardFor(symbol: string | undefined, timeframe: string): IctGapGuard | null {
  if (symbol !== XAUUSD_OANDA_PROFILE.symbol) return null;
  const match = /^(\d+)m$/.exec(timeframe.trim());
  const minutes = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return { barMinutes: minutes, minGapMinutes: GOLD_MIN_GAP_MINUTES, recoveryBars: GOLD_RECOVERY_BARS };
}

export interface MeasuredGap {
  /** Minutes missing inside the instrument's open hours. */
  readonly missingMinutes: number;
  /** The session dates those missing minutes belong to, in the profile's own session convention. */
  readonly sessionDates: ReadonlySet<string>;
}

/**
 * What is missing between two consecutive bars' open times: the bar-sized slots strictly between them that the profile says were open.
 * Null when the bars are adjacent, or when everything between them was a scheduled closure.
 */
export function measureGap(previousOpen: Date, nextOpen: Date, barMinutes: number, profile: InstrumentProfile): MeasuredGap | null {
  const barMs = barMinutes * 60_000;
  if (nextOpen.getTime() - previousOpen.getTime() <= barMs) return null;
  let missingMinutes = 0;
  const sessionDates = new Set<string>();
  for (let slot = previousOpen.getTime() + barMs; slot < nextOpen.getTime(); slot += barMs) {
    const instant = new Date(slot);
    if (!profile.isSessionActive(instant)) continue;
    missingMinutes += barMinutes;
    sessionDates.add(sessionDateKey(profile, instant));
  }
  return missingMinutes === 0 ? null : { missingMinutes, sessionDates };
}
