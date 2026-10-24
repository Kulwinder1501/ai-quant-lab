/**
 * How much of each regular session the stored data covers, per source. Pure.
 *
 * Three sources feed the terminal: 1-minute futures bars (volume profile, volume by time, developing value), option-chain
 * snapshots (the chain, Greeks, exposure, OI history) and depth frames (the depth views). Each can be thin on a day for a
 * different reason (a daily request budget, a collector that was down, a restart), and every view says "partial" on its own
 * page only after the reader has already chosen that day. This puts all three side by side.
 *
 * Everything here is a COUNT or a time of what is stored, and each status rule is a stated threshold, not a judgement:
 *
 * - **Futures bars:** complete at 96% of the 375 regular minutes (the same share the profile uses), none at zero.
 * - **Chain snapshots:** the collector runs about four times an hour, not once a minute, so there is no
 *   fixed expected count. A day is complete when its first in-session snapshot is by 10:00 IST, its last at or after 15:00 and its
 *   count is at least 70% of the typical day's (the median of the days that have any). Pre-open (09:11, previous-close
 *   carryover) and post-close snapshots are not counted in the session.
 * - **Depth frames:** a day is complete when the first frame is by 09:30 IST, the last at or after 15:15 and the capped count
 *   reached the cap. The count is capped (a full day is tens of thousands of frames), so this says "the span is covered and the
 *   day is not nearly empty"; it does NOT say there is no gap inside the span. The depth history view shows those.
 *
 * **A source with nothing in the whole window is "not collected", once.** The depth collector follows one symbol at a time (the
 * Fyers depth feed carries one), so for the other index there is no depth on any day. Listing that as a gap on every day would
 * bury the real gaps; it is reported once at the top and left out of the gap logic.
 *
 * **Holidays are inferred, from the exchange's own bars.** The exchange holiday calendar is not stored here, and the collectors
 * have no calendar either: on 2026-10-20 (a holiday) they still wrote 9 chain snapshots and 4 depth frames. Futures bars come
 * from the exchange, so a weekday with none, and with neither of the collectors' sources complete, is a probable holiday and is
 * reported as one, not as three failures. A day with futures bars and a source that has none, or with no futures bars but a collector
 * source complete, is a real gap on a day the market traded. The page says the holiday call is an inference.
 */
import { COMPLETE_SESSION_MIN_BAR_SHARE, EXPECTED_SESSION_MINUTES } from "./session-volume-profile.js";

export type CoverageStatus = "complete" | "partial" | "none";

export const FUTURES_COMPLETE_BARS = Math.ceil(EXPECTED_SESSION_MINUTES * COMPLETE_SESSION_MIN_BAR_SHARE);
/** IST minutes of the day. */
export const SNAPSHOT_FIRST_BY_MINUTE = 10 * 60;
export const SNAPSHOT_LAST_AT_OR_AFTER_MINUTE = 15 * 60;
export const SNAPSHOT_MIN_SHARE_OF_TYPICAL = 0.7;
export const DEPTH_FIRST_BY_MINUTE = 9 * 60 + 30;
export const DEPTH_LAST_AT_OR_AFTER_MINUTE = 15 * 60 + 15;

export const COVERAGE_DAY_CHOICES = [10, 20, 40] as const;

const IST_OFFSET_MS = 330 * 60_000;

export function istMinuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export interface FuturesCoverage {
  symbol: string | null;
  bars: number;
  barsWithVolume: number;
  firstAt: string | null;
  lastAt: string | null;
  status: CoverageStatus;
}

export interface SnapshotCoverage {
  inSessionMinutes: number;
  preOpenMinutes: number;
  postCloseMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
  /** The typical day's in-session count this day was judged against; null when no day has any. */
  typicalMinutes: number | null;
  status: CoverageStatus;
}

export interface DepthCoverage {
  symbol: string | null;
  framesCapped: number;
  capReached: boolean;
  firstAt: string | null;
  lastAt: string | null;
  status: CoverageStatus;
}

export function futuresStatus(bars: number): CoverageStatus {
  if (bars <= 0) return "none";
  return bars >= FUTURES_COMPLETE_BARS ? "complete" : "partial";
}

export function snapshotStatus(input: { inSessionMinutes: number; firstAt: Date | null; lastAt: Date | null; typicalMinutes: number | null }): CoverageStatus {
  if (input.inSessionMinutes <= 0 || input.firstAt === null || input.lastAt === null) return "none";
  const enough = input.typicalMinutes === null || input.inSessionMinutes >= SNAPSHOT_MIN_SHARE_OF_TYPICAL * input.typicalMinutes;
  return enough
    && istMinuteOfDay(input.firstAt) <= SNAPSHOT_FIRST_BY_MINUTE
    && istMinuteOfDay(input.lastAt) >= SNAPSHOT_LAST_AT_OR_AFTER_MINUTE
    ? "complete"
    : "partial";
}

export function depthStatus(input: { framesCapped: number; capReached: boolean; firstAt: Date | null; lastAt: Date | null }): CoverageStatus {
  if (input.framesCapped <= 0 || input.firstAt === null || input.lastAt === null) return "none";
  return input.capReached
    && istMinuteOfDay(input.firstAt) <= DEPTH_FIRST_BY_MINUTE
    && istMinuteOfDay(input.lastAt) >= DEPTH_LAST_AT_OR_AFTER_MINUTE
    ? "complete"
    : "partial";
}

/** The median of the in-session snapshot counts of the days that have any, or null with none. */
export function typicalSnapshotMinutes(counts: readonly number[]): number | null {
  const present = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  return present.length % 2 === 1 ? present[middle]! : (present[middle - 1]! + present[middle]!) / 2;
}

export interface CoverageDay {
  date: string;
  futures: FuturesCoverage;
  snapshots: SnapshotCoverage;
  depth: DepthCoverage;
  /** The day is today and the session is still running: later data is still to come. */
  inProgress: boolean;
  /**
   * No futures bars, and neither collector source complete: most likely an exchange holiday (an inference; the calendar is not
   * stored here). The collectors may still have written stray rows that day.
   */
  probableHoliday: boolean;
  /** The market traded (futures bars exist, or either collector source is complete) and a source has nothing: a real gap. */
  gapInSource: boolean;
}

export type SourceName = "futures" | "snapshots" | "depth";

/** The sources that have at least one stored row somewhere in the window; the others were not collected for it. */
export function sourcesNotCollected(days: ReadonlyArray<Pick<CoverageDay, "futures" | "snapshots" | "depth">>): SourceName[] {
  if (days.length === 0) return [];
  return (["futures", "snapshots", "depth"] as const).filter((name) => days.every((day) => day[name].status === "none"));
}

export function classifyDay(
  day: Omit<CoverageDay, "probableHoliday" | "gapInSource">,
  notCollected: readonly SourceName[] = [],
): CoverageDay {
  const { futures, snapshots, depth } = day;
  // Evidence the market ran: the exchange's bars, or a whole day from either collector (stray holiday rows are never a whole day).
  const probableHoliday = futures.status === "none" && snapshots.status !== "complete" && depth.status !== "complete";
  const considered = (["futures", "snapshots", "depth"] as const).filter((name) => !notCollected.includes(name));
  return {
    ...day,
    probableHoliday,
    gapInSource: !probableHoliday && considered.some((name) => day[name].status === "none"),
  };
}

export const DATA_COVERAGE_DEFINITIONS = {
  counts: "Every figure is a count or a time of what is stored. Nothing is estimated.",
  futures: `Futures bars: complete at ${FUTURES_COMPLETE_BARS} of the 375 regular minutes (96%), partial below, none at zero.`,
  snapshots: "Chain snapshots: complete when the first in-session snapshot is by 10:00 IST, the last at or after 15:00 and the count is at least 70% of the typical day's (the median of the days that have any). The collector runs about four times an hour, not every minute. Pre-open (previous-close carryover) and post-close snapshots are not in the session count.",
  depth: "Depth frames: complete when the first frame is by 09:30 IST, the last at or after 15:15 and the capped count reached the cap. The count is capped, so this does not say there is no gap inside the span: the depth history shows those.",
  notCollected: "A source with nothing in the whole window is not collected for this index (the depth collector follows one symbol at a time), or has been down for the whole window. It is reported once and left out of the gap logic.",
  noData: "A weekday with no futures bars (the exchange's own data) and neither collector source complete is most likely an exchange holiday, even if the collectors wrote stray rows. That is an inference: the holiday calendar is not stored here.",
  gap: "A day the market traded (futures bars exist, or either collector source is complete) with a source that has nothing is a real gap.",
} as const;
