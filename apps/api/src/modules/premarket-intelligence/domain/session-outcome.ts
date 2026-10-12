import { istInstant } from "../../platform/calendar/trading-session.js";
import type { CandidateLevel } from "./snapshot.js";
import {
  classifyReturn,
  CLOSE_VWAP_START_MINUTE,
  FIRST_HOUR_MARK_MINUTE,
  returnPercent,
  SESSION_CLOSE_MINUTE,
  SESSION_OPEN_MINUTE,
  TARGET_THRESHOLD_PCT,
  volumeWeightedAveragePrice,
  type MeasuredOutcome,
  type MinuteBar,
  type PremarketInstrument,
  type PremarketTarget,
} from "./targets.js";

/** Fewer closing-window bars than this means the feed froze or lagged; the VWAP would not be the contract's. */
export const MIN_CLOSE_WINDOW_BARS = 20;

export interface LevelTouch {
  levelRef: string;
  price: number;
  touched: boolean;
  firstTouchAt: string | null;
}

export interface SessionOutcome {
  instrument: PremarketInstrument;
  sessionDate: string;
  previousClose: number | null;
  open0915: number | null;
  price1015: number | null;
  closingVwap: number | null;
  gapReturnPct: number | null;
  first60ReturnPct: number | null;
  fullSessionReturnPct: number | null;
  gapOutcome: MeasuredOutcome | null;
  first60Outcome: MeasuredOutcome | null;
  fullSessionOutcome: MeasuredOutcome | null;
  levelTouches: LevelTouch[];
  /** Why a target has no outcome. A target with an outcome never appears here. */
  unmeasurable: Partial<Record<PremarketTarget, string>>;
}

/**
 * Measures the three pre-registered targets for one instrument-session from stored 1m bars.
 *
 * - Gap: the 09:15 bar's open against the previous official close.
 * - First 60 minutes: the close of the 10:14 bar (the price at 10:15) against the 09:15 open.
 * - Full session: the 15:00-15:30 VWAP against the 09:15 open.
 *
 * A target whose input is absent is recorded as unmeasurable with the reason. It is never
 * substituted from a neighbouring bar or a different statistic: a graded outcome must be the one
 * the contract defined, and a quietly approximated one would contaminate every score built on it.
 */
export function measureSession(input: {
  instrument: PremarketInstrument;
  sessionDate: string;
  previousClose: number | null;
  /** Completed 1m bars of the session, in any order. */
  bars: readonly MinuteBar[];
  candidateLevels: readonly CandidateLevel[];
}): SessionOutcome {
  const at = (minute: number): number => istInstant(input.sessionDate, minute).getTime();
  const byOpenTime = new Map(input.bars.map((bar) => [bar.openTime.getTime(), bar]));
  const unmeasurable: SessionOutcome["unmeasurable"] = {};

  const openBar = byOpenTime.get(at(SESSION_OPEN_MINUTE));
  const open0915 = openBar?.open ?? null;
  const markBar = byOpenTime.get(at(FIRST_HOUR_MARK_MINUTE - 1));
  const price1015 = markBar?.close ?? null;

  const closeWindow = input.bars.filter(
    (bar) => bar.openTime.getTime() >= at(CLOSE_VWAP_START_MINUTE) && bar.openTime.getTime() < at(SESSION_CLOSE_MINUTE),
  );
  const closingVwap = closeWindow.length >= MIN_CLOSE_WINDOW_BARS ? volumeWeightedAveragePrice(closeWindow) : null;

  let gapReturnPct: number | null = null;
  let gapOutcome: MeasuredOutcome | null = null;
  if (open0915 === null) unmeasurable.OPENING_GAP = "NO_0915_BAR";
  else if (input.previousClose === null) unmeasurable.OPENING_GAP = "NO_PREVIOUS_CLOSE";
  else {
    gapReturnPct = returnPercent(input.previousClose, open0915);
    gapOutcome = classifyReturn(gapReturnPct, TARGET_THRESHOLD_PCT.OPENING_GAP[input.instrument]);
  }

  let first60ReturnPct: number | null = null;
  let first60Outcome: MeasuredOutcome | null = null;
  if (open0915 === null) unmeasurable.FIRST_60_MINUTES = "NO_0915_BAR";
  else if (price1015 === null) unmeasurable.FIRST_60_MINUTES = "NO_1014_BAR";
  else {
    first60ReturnPct = returnPercent(open0915, price1015);
    first60Outcome = classifyReturn(first60ReturnPct, TARGET_THRESHOLD_PCT.FIRST_60_MINUTES[input.instrument]);
  }

  let fullSessionReturnPct: number | null = null;
  let fullSessionOutcome: MeasuredOutcome | null = null;
  if (open0915 === null) unmeasurable.FULL_SESSION = "NO_0915_BAR";
  else if (closingVwap === null) {
    unmeasurable.FULL_SESSION = closeWindow.length < MIN_CLOSE_WINDOW_BARS
      ? `CLOSE_WINDOW_HAS_${closeWindow.length}_BARS`
      : "NO_CLOSE_WINDOW_VOLUME";
  } else {
    fullSessionReturnPct = returnPercent(open0915, closingVwap);
    fullSessionOutcome = classifyReturn(fullSessionReturnPct, TARGET_THRESHOLD_PCT.FULL_SESSION[input.instrument]);
  }

  const sessionBars = input.bars
    .filter((bar) => bar.openTime.getTime() >= at(SESSION_OPEN_MINUTE) && bar.openTime.getTime() < at(SESSION_CLOSE_MINUTE))
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const levelTouches: LevelTouch[] = input.candidateLevels
    .filter((level) => level.instrument === input.instrument)
    .map((level) => {
      const touch = sessionBars.find((bar) => bar.low <= level.price && level.price <= bar.high);
      return { levelRef: level.id, price: level.price, touched: touch !== undefined, firstTouchAt: touch ? touch.openTime.toISOString() : null };
    });

  return {
    instrument: input.instrument,
    sessionDate: input.sessionDate,
    previousClose: input.previousClose,
    open0915,
    price1015,
    closingVwap,
    gapReturnPct,
    first60ReturnPct,
    fullSessionReturnPct,
    gapOutcome,
    first60Outcome,
    fullSessionOutcome,
    levelTouches,
    unmeasurable,
  };
}
