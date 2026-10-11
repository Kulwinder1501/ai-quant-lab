import type { PatternCandle } from "./market-pattern.js";

/**
 * Session handling for the pattern engines.
 *
 * The engines are pure functions over one contiguous series. Handing them an intraday history as
 * a single series let a bar at 09:15 use the previous day's last bars as its "prior" candles:
 * measured live, the 09:15 5m bar carried 2,130 OUTSIDE_BAR, 517 BEARISH_ENGULFING and 185
 * EVENING_STAR detections built against yesterday's close, and chart-pattern breakouts took a
 * median 1,170 minutes (880 of 1,435 crossed a day) to arrive. The fix is structural rather than
 * per-rule: an intraday series is cut at the IST session date and each session is detected on its
 * own, so no pattern can use a bar from a previous session as one of its bars.
 */

const istOffsetMs = 5.5 * 60 * 60 * 1000;
const minutesPerDay = 24 * 60;

/** Length of one bar in minutes, or null for an unrecognised timeframe label. */
export function timeframeMinutes(timeframe: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  return match[2] === "m" ? count : match[2] === "h" ? count * 60 : count * minutesPerDay;
}

/**
 * Intraday means strictly shorter than a day. `1440m` (a daily bar stored under a minute label)
 * is a daily series and keeps the single-series behaviour; an unparseable label is treated as
 * not intraday so that an unknown timeframe never silently loses history.
 */
export function isIntradayTimeframe(timeframe: string): boolean {
  const minutes = timeframeMinutes(timeframe);
  return minutes !== null && minutes < minutesPerDay;
}

/** The IST calendar date (YYYY-MM-DD) of an instant -- the session key for NSE intraday bars. */
export function istSessionDate(instant: Date): string {
  return new Date(instant.getTime() + istOffsetMs).toISOString().slice(0, 10);
}

/**
 * Cuts the series into IST sessions for intraday timeframes; returns the series unchanged (as a
 * single segment) otherwise. Order is preserved and every candle appears in exactly one segment.
 * The input must already be chronological (the application asserts that).
 */
export function splitIntoSessions<T extends Pick<PatternCandle, "openTime">>(
  candles: readonly T[],
  timeframe: string,
): T[][] {
  if (candles.length === 0) return [];
  if (!isIntradayTimeframe(timeframe)) return [[...candles]];

  const sessions: T[][] = [];
  let current: T[] = [];
  let currentKey: string | null = null;
  for (const candle of candles) {
    const key = istSessionDate(candle.openTime);
    if (key !== currentKey) {
      if (current.length > 0) sessions.push(current);
      current = [];
      currentKey = key;
    }
    current.push(candle);
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * Ids of bars that must not produce, or take part in, a detection.
 *
 * - A flat bar with no volume (`high === low && volume === 0`) is a holiday / no-trade print.
 * - A zero-volume bar inside a series that otherwise reports volume is a stale or missing print.
 *   Zero volume is only evidence of "no trade" when the feed reports volume at all: OANDA FX, DXY
 *   and INDIAVIX candles carry volume 0 on every bar, and treating that as suppression would
 *   silence those series entirely. So the volume rule applies only to a segment in which at
 *   least one bar has volume > 0.
 */
export function findSuppressedCandleIds(segment: readonly PatternCandle[]): Set<string> {
  const suppressed = new Set<string>();
  const segmentReportsVolume = segment.some((candle) => candle.volume > 0);
  for (const candle of segment) {
    const flat = candle.high === candle.low;
    if (candle.volume === 0 && (flat || segmentReportsVolume)) suppressed.add(candle.id);
  }
  return suppressed;
}
