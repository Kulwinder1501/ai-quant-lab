import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { XAUUSD_OANDA_PROFILE } from "../../platform/calendar/instrument-profile.js";

const MINUTE_MS = 60_000;

export interface MissingXauRange {
  /** First missing 1m bar's open time. */
  from: Date;
  /** Last missing 1m bar's open time (inclusive). */
  to: Date;
  /** Number of missing session-active minutes in this range. */
  minutes: number;
}

export interface FindMissingXauRangesInput {
  /** Sorted ascending 1m bar open times already stored. */
  openTimes: Date[];
  /** Last minute (exclusive) the scan is allowed to call missing; anything newer is the live collector's job. */
  scanTo: Date;
  isSessionActive: (minute: Date) => boolean;
  minMissingMinutes: number;
}

/**
 * Finds runs of missing 1m bars that fall inside gold's trading session.
 *
 * A stored-bar gap is only a real hole where the market was actually open: the weekend close
 * and OANDA's daily 17:00-18:00 New York break show up as gaps in the data too, and fetching
 * them would only ever return nothing. Walking the missing minutes and keeping the ones
 * `isSessionActive` accepts is what separates "the machine was asleep" from "the market was shut".
 */
export function findMissingXauRanges(input: FindMissingXauRangesInput): MissingXauRange[] {
  const { openTimes, scanTo, isSessionActive, minMissingMinutes } = input;
  const ranges: MissingXauRange[] = [];
  if (openTimes.length === 0) return ranges;

  let runStart: number | null = null;
  let runEnd = 0;
  let runMinutes = 0;

  const flush = (): void => {
    if (runStart !== null && runMinutes >= minMissingMinutes) {
      ranges.push({ from: new Date(runStart), to: new Date(runEnd), minutes: runMinutes });
    }
    runStart = null;
    runMinutes = 0;
  };

  const scanToMs = scanTo.getTime();
  for (let index = 0; index < openTimes.length; index += 1) {
    const previous = openTimes[index]!.getTime();
    const next = index + 1 < openTimes.length ? openTimes[index + 1]!.getTime() : scanToMs;
    for (let minute = previous + MINUTE_MS; minute < next && minute < scanToMs; minute += MINUTE_MS) {
      if (isSessionActive(new Date(minute))) {
        if (runStart === null) runStart = minute;
        runEnd = minute;
        runMinutes += 1;
      } else {
        flush();
      }
    }
    flush();
  }
  return ranges;
}

/** Splits a range into chunks of at most `maxMinutes` so each stays under the provider's per-request bar cap. */
export function chunkMissingRange(range: MissingXauRange, maxMinutes: number): MissingXauRange[] {
  const chunks: MissingXauRange[] = [];
  let cursor = range.from.getTime();
  const end = range.to.getTime();
  while (cursor <= end) {
    const chunkEnd = Math.min(cursor + (maxMinutes - 1) * MINUTE_MS, end);
    chunks.push({
      from: new Date(cursor),
      to: new Date(chunkEnd),
      minutes: Math.round((chunkEnd - cursor) / MINUTE_MS) + 1,
    });
    cursor = chunkEnd + MINUTE_MS;
  }
  return chunks;
}

export interface ScanXauGapsOptions {
  lookbackDays: number;
  minMissingMinutes: number;
  /** Anything newer than `now - tailGraceMinutes` is left to the regular 15-minute collection tick. */
  tailGraceMinutes: number;
  now?: Date;
}

export async function scanXauGaps(
  database: Pick<DatabasePool, "query">,
  options: ScanXauGapsOptions,
): Promise<MissingXauRange[]> {
  const now = options.now ?? new Date();
  const scanFrom = new Date(now.getTime() - options.lookbackDays * 24 * 60 * MINUTE_MS);
  const scanTo = new Date(now.getTime() - options.tailGraceMinutes * MINUTE_MS);

  const result = await database.query<{ open_time: Date }>(
    `SELECT c.open_time
       FROM candles c
       JOIN instruments i ON i.id = c.instrument_id
      WHERE i.exchange = 'OANDA' AND i.symbol = 'XAU_USD'
        AND c.timeframe = '1m'
        AND c.open_time >= $1
      ORDER BY c.open_time ASC`,
    [scanFrom],
  );

  return findMissingXauRanges({
    openTimes: result.rows.map((row) => new Date(row.open_time)),
    scanTo,
    isSessionActive: (minute) => XAUUSD_OANDA_PROFILE.isSessionActive(minute),
    minMissingMinutes: options.minMissingMinutes,
  });
}
