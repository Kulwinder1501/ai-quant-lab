/**
 * Data-readiness assessment (Phase 25, Workstream A).
 *
 * Pure functions only: measurements come in, a state and its reasons come out.
 * Everything that touches the database lives in the repository; everything that
 * decides lives here, where it can be tested without a database.
 *
 * States, in increasing severity:
 *
 * - READY:    all hard requirements pass; training may proceed.
 * - DEGRADED: coverage or derived-evidence gaps; inference may continue with the
 *             gaps visible, but training on this series is blocked.
 * - STALE:    the series is older than its allowed cadence; training and new
 *             predictions stop until collection catches up.
 * - INVALID:  integrity or provenance failure; the series is quarantined.
 *
 * A blocked state is a finding, not an error: the audit's job is to say it
 * plainly and machine-readably rather than let a training run discover it as a
 * mysteriously weak score.
 */

export const DATA_READINESS_REPORT_VERSION = "data-readiness-v1";

export type SeriesState = "READY" | "DEGRADED" | "STALE" | "INVALID";

/**
 * Production `ta-v1` indicators a feature schema reads. VWAP is deliberately
 * absent: it is undefined without traded volume, and legitimately missing on
 * index series whose volume is zero — its coverage is reported but never gated.
 */
export const REQUIRED_INDICATOR_CODES = [
  "ATR",
  "BOLLINGER_BANDS",
  "EMA",
  "MACD",
  "RSI",
  "SMA",
  "SUPERTREND",
] as const;

export const DATA_READINESS_THRESHOLDS = {
  /**
   * Phase 25's "at least 99% expected-bar completeness". Expected bars per
   * session are self-calibrated as the series' own modal bars-per-session,
   * because no exchange holiday/halt calendar is stored — the modal count
   * needs no calendar and still catches partial sessions and dropped ranges.
   */
  minimumIntradayCompleteness: 0.99,
  /** Phase 25's "at least 95% required indicator coverage before a schema may train". */
  minimumIndicatorCoverage: 0.95,
  /**
   * Trailing indicators have no value for their warm-up window, so coverage is
   * measured over bars after this allowance (MACD's slow EMA plus signal line
   * is the longest warm-up in `ta-v1` at 26 + 9 bars).
   */
  indicatorCoverageWarmupBars: 40,
  /**
   * Missed weekday sessions before a series counts as stale. Three tolerates a
   * long holiday weekend plus one failed collection; a fourth missed session
   * means the collector is broken, not the calendar.
   */
  maximumAgeWeekdays: 3,
  /**
   * Longest internal run of missing weekday sessions tolerated as holidays.
   * NSE's longest holiday clusters run two to three weekdays; five in a row is
   * a collection gap.
   */
  maximumGapWeekdays: 5,
} as const;

export interface SeriesMeasurements {
  symbol: string;
  exchange: string;
  instrumentType: string;
  isActive: boolean;
  timeframe: string;
  /** Distinct `candles.source` values observed in the series. */
  providers: string[];
  barCount: number;
  provisionalBars: number;
  /** Provisional bars whose window closed over an hour ago and were never finalised. */
  expiredProvisionalBars: number;
  duplicateOpenTimes: number;
  invalidOhlcBars: number;
  negativeVolumeBars: number;
  firstOpenTime: string;
  lastOpenTime: string;
  lastCloseTime: string;
  sessionCount: number;
  /** Most common bars-per-session; null for the `1d` timeframe where it is definitionally 1. */
  modalBarsPerSession: number | null;
  /** barCount / (modal x sessions), capped at 1; null for `1d`. */
  completeness: number | null;
  /** Longest internal run of weekday dates with no session. */
  longestGapWeekdays: number;
  /** Weekday dates with no session between the last session and today. */
  ageWeekdays: number;
  zeroVolumeFraction: number;
  medianVolume: number;
  /** Fraction of post-warm-up bars carrying a `ta-v1` snapshot, per indicator code. */
  indicatorCoverage: Record<string, number>;
}

export interface SeriesAssessment {
  state: SeriesState;
  reasons: string[];
}

/**
 * Weekday (Mon-Fri) dates strictly between two YYYY-MM-DD date keys.
 *
 * This is the audit's clock: freshness and gaps are measured in missed weekday
 * sessions, not wall-clock hours, so a Friday close is not "stale" on Sunday.
 * Holidays are indistinguishable from missed sessions without a calendar, which
 * is why the thresholds above leave room for holiday runs.
 */
export function weekdaysBetween(fromDateKey: string, toDateKey: string): number {
  const cursor = new Date(`${fromDateKey}T00:00:00Z`);
  const end = new Date(`${toDateKey}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || end <= cursor) return 0;
  let count = 0;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor < end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Longest run of missing weekday dates between consecutive session date keys. */
export function longestSessionGapWeekdays(sortedSessionDates: readonly string[]): number {
  let longest = 0;
  for (let index = 1; index < sortedSessionDates.length; index += 1) {
    const gap = weekdaysBetween(sortedSessionDates[index - 1]!, sortedSessionDates[index]!);
    if (gap > longest) longest = gap;
  }
  return longest;
}

/** Most frequent value; ties break toward the larger count so stub sessions do not win. */
export function modalValue(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let modal = values[0]!;
  let best = 0;
  for (const [value, count] of counts) {
    if (count > best || (count === best && value > modal)) {
      modal = value;
      best = count;
    }
  }
  return modal;
}

export function assessSeries(
  measurements: SeriesMeasurements,
  thresholds: typeof DATA_READINESS_THRESHOLDS = DATA_READINESS_THRESHOLDS,
): SeriesAssessment {
  const invalidReasons: string[] = [];
  if (measurements.duplicateOpenTimes > 0) {
    invalidReasons.push(`${measurements.duplicateOpenTimes} duplicated open time(s) within one series.`);
  }
  if (measurements.invalidOhlcBars > 0) {
    invalidReasons.push(`${measurements.invalidOhlcBars} bar(s) violate OHLC ordering.`);
  }
  if (measurements.negativeVolumeBars > 0) {
    invalidReasons.push(`${measurements.negativeVolumeBars} bar(s) carry negative volume.`);
  }
  if (measurements.providers.length > 1) {
    invalidReasons.push(
      `Mixed provider lineage (${measurements.providers.join(", ")}). One series must have one provider; `
      + "a silent cutover changes what the numbers mean mid-history.",
    );
  }
  if (invalidReasons.length > 0) {
    return { state: "INVALID", reasons: invalidReasons };
  }

  if (measurements.ageWeekdays > thresholds.maximumAgeWeekdays) {
    return {
      state: "STALE",
      reasons: [
        `Last session is ${measurements.ageWeekdays} weekday session(s) old, beyond the `
        + `${thresholds.maximumAgeWeekdays}-session tolerance.`,
      ],
    };
  }

  const degradedReasons: string[] = [];
  if (measurements.expiredProvisionalBars > 0) {
    degradedReasons.push(
      `${measurements.expiredProvisionalBars} provisional bar(s) whose window closed over an hour ago `
      + "were never finalised.",
    );
  }
  if (
    measurements.completeness !== null
    && measurements.completeness < thresholds.minimumIntradayCompleteness
  ) {
    degradedReasons.push(
      `Completeness ${(measurements.completeness * 100).toFixed(2)}% against the series' modal `
      + `${measurements.modalBarsPerSession} bars/session, below the `
      + `${thresholds.minimumIntradayCompleteness * 100}% floor.`,
    );
  }
  if (measurements.longestGapWeekdays > thresholds.maximumGapWeekdays) {
    degradedReasons.push(
      `Longest internal gap is ${measurements.longestGapWeekdays} weekday session(s), beyond the `
      + `${thresholds.maximumGapWeekdays}-session holiday allowance.`,
    );
  }
  for (const code of REQUIRED_INDICATOR_CODES) {
    const coverage = measurements.indicatorCoverage[code] ?? 0;
    if (coverage < thresholds.minimumIndicatorCoverage) {
      degradedReasons.push(
        `ta-v1 ${code} covers ${(coverage * 100).toFixed(1)}% of post-warm-up bars, below the `
        + `${thresholds.minimumIndicatorCoverage * 100}% floor.`,
      );
    }
  }
  if (degradedReasons.length > 0) {
    return { state: "DEGRADED", reasons: degradedReasons };
  }

  return { state: "READY", reasons: [] };
}

/**
 * Canonical JSON: keys sorted recursively, no whitespace. The report hash must
 * not depend on object-property insertion order, or two identical audits would
 * disagree about their own identity.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
