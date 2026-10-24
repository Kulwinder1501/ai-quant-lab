/**
 * How old the stored option quotes are, and which contracts have stopped moving. Pure.
 *
 * Every row of one stored chain snapshot carries the same `observed_at`: the chain is one observation, taken when the collector's
 * run reached the broker, about four times an hour (:11 :23 :41 :53, so the gap alternates 12 and 18 minutes). Two things follow
 * that a reader of an ask or a breakeven needs, and neither is on the page otherwise:
 *
 * 1. **The age of the whole chain.** At 12:41 a chain from 12:23 is normal; a chain from 11:53 means runs were missed. "Old" is
 *    judged against the cadence the collector has actually kept recently (its longest in-session gap among the newest snapshots),
 *    not against a number invented here. Outside the session no quote is being updated, so age is reported but not judged.
 * 2. **Contracts whose quote did not change.** For each contract in the newest snapshot, how many of the newest snapshots, going
 *    back, carry exactly the same bid and ask. A quote that repeats across several snapshots is not by itself stale (a far strike
 *    sits still for hours), but it is the one signal in the stored data that a price may not be live, and the reader can weigh it.
 *    Unknown is not unchanged: a snapshot in which the contract is absent (the strike window slides) ends the run, and so does a
 *    one-sided quote or a snapshot from another IST day.
 *
 * Neither is a verdict on whether the price can be traded at.
 */
import { istDateOf } from "./collector-causes.js";
import { istMinuteOfDay } from "./data-coverage.js";

export interface SnapshotQuotes {
  observedAt: Date;
  quotes: Array<{ strike: number; side: "CE" | "PE"; bid: number | null; ask: number | null }>;
}

/** How many of the newest snapshots are compared. Enough to span a morning at the collector's cadence. */
export const STALENESS_WINDOW = 8;
/** The widest gap between runs the collector's schedule produces, used only when too few snapshots exist to observe one. */
export const ASSUMED_EXPECTED_GAP_SECONDS = 18 * 60;
/** A gap longer than this spans a close or a missed stretch, not the collector's cadence, and is left out of the expected gap. */
const MAX_CADENCE_GAP_SECONDS = 90 * 60;

export const AGING_FACTOR = 1;
export const OVERDUE_FACTOR = 1.5;

const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
/** Within this many minutes of the open, a chain still from an earlier day is "awaiting the first one", not "overdue". */
const FIRST_SNAPSHOT_GRACE_MINUTE = 9 * 60 + 35;

/** True on an IST weekday between the open and the close that is not a listed holiday. */
export function isMarketOpen(now: Date, holiday: boolean): boolean {
  if (holiday) return false;
  const weekday = new Date(now.getTime() + 330 * 60_000).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = istMinuteOfDay(now);
  return minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE;
}

export type AgeState = "none" | "market-closed" | "awaiting-first" | "fresh" | "aging" | "overdue";

export interface AgeAssessment {
  state: AgeState;
  newestAt: string | null;
  ageSeconds: number | null;
  /** The longest in-session gap among the newest snapshots (observed), or the schedule's widest gap (assumed) when none can be seen. */
  expectedGapSeconds: number;
  expectedGapFrom: "observed" | "assumed";
  agingFactor: number;
  overdueFactor: number;
}

/** The judgment of an age against an expected gap: `fresh` up to it, `aging` up to 1.5 times it, `overdue` beyond. */
export function ageStateOf(ageSeconds: number, expectedGapSeconds: number): "fresh" | "aging" | "overdue" {
  if (ageSeconds <= expectedGapSeconds * AGING_FACTOR) return "fresh";
  if (ageSeconds <= expectedGapSeconds * OVERDUE_FACTOR) return "aging";
  return "overdue";
}

function inSession(instant: Date): boolean {
  const minute = istMinuteOfDay(instant);
  return minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE;
}

/** The newest in-session gaps between consecutive snapshots of one IST day, in seconds. Gaps across days or across a close are not cadence. */
export function recentSessionGaps(snapshotTimes: readonly Date[]): number[] {
  const newestFirst = [...snapshotTimes].sort((a, b) => b.getTime() - a.getTime());
  const gaps: number[] = [];
  for (let index = 0; index + 1 < newestFirst.length; index += 1) {
    const newer = newestFirst[index]!;
    const older = newestFirst[index + 1]!;
    if (istDateOf(newer) !== istDateOf(older) || !inSession(newer) || !inSession(older)) continue;
    const gap = (newer.getTime() - older.getTime()) / 1000;
    if (gap <= MAX_CADENCE_GAP_SECONDS) gaps.push(gap);
  }
  return gaps;
}

export function assessAge(snapshotTimes: readonly Date[], now: Date, marketOpen: boolean): AgeAssessment {
  const gaps = recentSessionGaps(snapshotTimes);
  const observed = gaps.length > 0;
  const base = {
    expectedGapSeconds: observed ? Math.max(...gaps) : ASSUMED_EXPECTED_GAP_SECONDS,
    expectedGapFrom: observed ? "observed" as const : "assumed" as const,
    agingFactor: AGING_FACTOR,
    overdueFactor: OVERDUE_FACTOR,
  };
  if (snapshotTimes.length === 0) return { state: "none", newestAt: null, ageSeconds: null, ...base };
  const newest = new Date(Math.max(...snapshotTimes.map((time) => time.getTime())));
  const ageSeconds = Math.max(0, (now.getTime() - newest.getTime()) / 1000);
  const common = { newestAt: newest.toISOString(), ageSeconds, ...base };
  if (!marketOpen) return { state: "market-closed", ...common };
  if (istDateOf(newest) !== istDateOf(now) && istMinuteOfDay(now) < FIRST_SNAPSHOT_GRACE_MINUTE) return { state: "awaiting-first", ...common };
  return { state: ageStateOf(ageSeconds, base.expectedGapSeconds), ...common };
}

export interface ContractStaleness {
  strike: number;
  side: "CE" | "PE";
  /** Newest snapshots, counting the newest itself, in a row with exactly this bid and ask. 1 means it changed at the last snapshot. */
  unchangedSnapshots: number;
  /** When the oldest snapshot of that run was observed: the quote has been this since at least then. */
  unchangedSinceAt: string;
}

/** For each contract with a two-sided quote in the newest snapshot, the run of newest snapshots that repeat its bid and ask. */
export function contractStaleness(snapshots: readonly SnapshotQuotes[]): ContractStaleness[] {
  const newestFirst = [...snapshots].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const newest = newestFirst[0];
  if (!newest) return [];
  const newestDay = istDateOf(newest.observedAt);
  const lookups = newestFirst.map((snapshot) => new Map(snapshot.quotes.map((quote) => [`${quote.strike}|${quote.side}`, quote])));

  const result: ContractStaleness[] = [];
  for (const quote of newest.quotes) {
    if (quote.bid === null || quote.ask === null) continue;
    const key = `${quote.strike}|${quote.side}`;
    let run = 1;
    let since = newest.observedAt;
    for (let index = 1; index < newestFirst.length; index += 1) {
      const older = newestFirst[index]!;
      if (istDateOf(older.observedAt) !== newestDay) break;
      const match = lookups[index]!.get(key);
      if (!match || match.bid !== quote.bid || match.ask !== quote.ask) break;
      run += 1;
      since = older.observedAt;
    }
    result.push({ strike: quote.strike, side: quote.side, unchangedSnapshots: run, unchangedSinceAt: since.toISOString() });
  }
  return result.sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
}

export const QUOTE_STALENESS_DEFINITIONS = {
  age: "Every row of a stored chain shares one observation time. Its age is now minus that time. During the session it is judged against the longest gap between the newest in-session snapshots (the collector's recent cadence): fresh up to that gap, aging up to 1.5 times it, overdue beyond. Outside the session no quote is updating, so the age is shown and not judged.",
  unchanged: "For each contract, how many of the newest snapshots in a row carry exactly the same bid and ask. A repeat is not proof of a stale price (a far strike can sit still for hours); it is the one signal in the stored data that a price may not be live. A snapshot that lacks the contract, a one-sided quote and a snapshot from another day all end the run.",
  notTradable: "Neither figure says whether the price can be traded at. They say how old the observation is and whether the quote moved.",
} as const;
