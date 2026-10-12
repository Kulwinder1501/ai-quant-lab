import { istInstant } from "../../platform/calendar/trading-session.js";
import type { PremarketInstrument } from "./targets.js";

/** NSE's pre-open call auction runs 09:00-09:08 and the matching result settles before the 09:15 open. */
const PREOPEN_START_MINUTE = 9 * 60;
const PREOPEN_END_MINUTE = 9 * 60 + 15;
/** An indicative print older than this at fetch time is treated as stale, not as "current". */
export const MAX_INDICATIVE_AGE_MS = 5 * 60_000;

export const INDEX_NAME_BY_INSTRUMENT: Record<PremarketInstrument, string> = {
  NIFTY50: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
};

export interface IndexIndicativeRow {
  indicativeClose: number | null;
  previousClose: number | null;
}

export type PreOpenGateResult =
  | {
      ok: true;
      observedAt: Date;
      gaps: Record<PremarketInstrument, { indicativeClose: number; previousClose: number; impliedGapPct: number }>;
    }
  | { ok: false; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses NSE's "12-Oct-2026 09:07" (IST, minute resolution) into an instant, or null. */
export function parseNseIndexTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month < 0) return null;
  const sessionDate = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const base = istInstant(sessionDate, hour * 60 + minute);
  return new Date(base.getTime() + Number(match[6] ?? 0) * 1000);
}

/**
 * Decides whether NSE's `allIndices` feed is carrying a TRUE indicative pre-open value.
 *
 * The 09:10 update is strictly conditional on this. `indicativeClose` is 0 whenever no auction
 * result is being published (verified 2026-10-12 after the close), so a non-zero value alone is not
 * enough: the payload's own timestamp must fall inside the pre-open window of the session being
 * predicted and be recent at fetch time. Anything else returns the specific reason, which the
 * caller records so a day with no indicative feed is distinguishable from a day the job never ran.
 */
export function evaluatePreOpenGate(input: {
  payloadTimestamp: unknown;
  rows: Partial<Record<PremarketInstrument, IndexIndicativeRow>>;
  sessionDate: string;
  now: Date;
}): PreOpenGateResult {
  const observedAt = parseNseIndexTimestamp(input.payloadTimestamp);
  if (!observedAt) return { ok: false, reason: "NO_PARSEABLE_TIMESTAMP" };

  const windowStart = istInstant(input.sessionDate, PREOPEN_START_MINUTE).getTime();
  const windowEnd = istInstant(input.sessionDate, PREOPEN_END_MINUTE).getTime();
  if (observedAt.getTime() < windowStart || observedAt.getTime() >= windowEnd) {
    return { ok: false, reason: "TIMESTAMP_OUTSIDE_PREOPEN_WINDOW" };
  }
  if (input.now.getTime() - observedAt.getTime() > MAX_INDICATIVE_AGE_MS) {
    return { ok: false, reason: "INDICATIVE_PRINT_STALE" };
  }

  const gaps = {} as Extract<PreOpenGateResult, { ok: true }>["gaps"];
  for (const instrument of ["NIFTY50", "BANKNIFTY"] as const) {
    const row = input.rows[instrument];
    if (!row || row.indicativeClose === null || !(row.indicativeClose > 0)) {
      return { ok: false, reason: `NO_INDICATIVE_VALUE_${instrument}` };
    }
    if (row.previousClose === null || !(row.previousClose > 0)) {
      return { ok: false, reason: `NO_PREVIOUS_CLOSE_${instrument}` };
    }
    gaps[instrument] = {
      indicativeClose: row.indicativeClose,
      previousClose: row.previousClose,
      impliedGapPct: ((row.indicativeClose - row.previousClose) / row.previousClose) * 100,
    };
  }
  return { ok: true, observedAt, gaps };
}
