import type { DatabasePool } from "../../../infrastructure/database/database.js";
import {
  classifySessionCoverage,
  type SessionCoverage,
} from "../domain/candle-gap-detection.js";

/**
 * Scans recently completed sessions of a live-collected series and classifies each one's coverage.
 *
 * Extracted so the detector (which fails a job on a confirmed gap) and the healer (which backfills one)
 * scan with the *same* query and the *same* session-shape mapping. Two copies of "pull the bars, bucket
 * them by IST session, map each close to a minute index, classify" would drift, and the healer must act
 * on exactly the sessions the detector flags — never a different set.
 */

export const REGULAR_SESSION_BARS: Record<string, number> = { "1m": 375, "3m": 125, "5m": 75, "15m": 25 };
export const BAR_MINUTES: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15 };
const SESSION_OPEN_IST_MINUTE = 9 * 60 + 15; // 09:15

function istMinuteOfDay(at: Date): number {
  return Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 60_000) % 1440;
}
function istDateKey(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

export interface ScannedSession {
  readonly instrument: string;
  readonly session: string; // IST date key, YYYY-MM-DD
  readonly timeframe: string;
  readonly coverage: SessionCoverage;
}

export interface CoverageScan {
  readonly sessionsChecked: number;
  readonly confirmed: ScannedSession[];
  readonly tailShort: ScannedSession[];
  readonly complete: ScannedSession[];
}

export interface ScanInput {
  readonly instruments: readonly string[];
  readonly timeframe: string;
  readonly lookbackDays: number;
}

/**
 * Returns the coverage classification of every completed session in the lookback window, per instrument.
 *
 * Only completed sessions are examined — never the in-progress day, which would always look short. A bar
 * outside the regular window (a Muhurat evening, say) is skipped rather than classified: it does not
 * belong to a regular-session shape, and `classifySessionCoverage` would reject it.
 */
export async function scanCandleCoverage(database: DatabasePool, input: ScanInput): Promise<CoverageScan> {
  const barsExpected = REGULAR_SESSION_BARS[input.timeframe];
  const barMinutes = BAR_MINUTES[input.timeframe];
  if (barsExpected === undefined || barMinutes === undefined) {
    throw new Error(`timeframe must be one of ${Object.keys(REGULAR_SESSION_BARS).join(", ")}.`);
  }
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays <= 0) {
    throw new Error("lookbackDays must be a positive integer.");
  }

  const confirmed: ScannedSession[] = [];
  const tailShort: ScannedSession[] = [];
  const complete: ScannedSession[] = [];
  let sessionsChecked = 0;

  for (const symbol of input.instruments) {
    const rows = await database.query<{ close_time: Date }>(`
      SELECT c.close_time
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1 AND c.timeframe = $2 AND c.is_complete = TRUE
        -- Completed sessions only: never the in-progress day, which would always look short.
        AND c.close_time >= (CURRENT_DATE - make_interval(days => $3))
        AND c.close_time < date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
                            AT TIME ZONE 'Asia/Kolkata'
      ORDER BY c.close_time ASC
    `, [symbol, input.timeframe, input.lookbackDays]);

    const bySession = new Map<string, number[]>();
    for (const row of rows.rows) {
      // Minute-of-session index: (close-minute - open - one bar) / barMinutes. The first bar of a 1m
      // session closes at 09:16, i.e. open + 1 minute, which must map to index 0.
      const index = Math.round((istMinuteOfDay(row.close_time) - SESSION_OPEN_IST_MINUTE - barMinutes) / barMinutes);
      const day = istDateKey(row.close_time);
      if (index < 0 || index >= barsExpected) continue;
      const bucket = bySession.get(day);
      if (bucket) bucket.push(index);
      else bySession.set(day, [index]);
    }

    for (const [day, indices] of bySession) {
      sessionsChecked += 1;
      const coverage = classifySessionCoverage({ presentMinuteIndices: indices, barsExpected });
      const scanned: ScannedSession = { instrument: symbol, session: day, timeframe: input.timeframe, coverage };
      if (coverage.kind === "CONFIRMED_GAP") confirmed.push(scanned);
      else if (coverage.kind === "TAIL_SHORT") tailShort.push(scanned);
      else complete.push(scanned);
    }
  }

  return { sessionsChecked, confirmed, tailShort, complete };
}
