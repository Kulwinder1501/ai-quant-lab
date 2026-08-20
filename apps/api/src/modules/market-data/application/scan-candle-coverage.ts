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

  // Enumerate expected regular sessions independently of candle rows. Without this calendar side,
  // an entirely absent day produces no bucket and is therefore invisible to a row-driven scan.
  const expectedResult = await database.query<{ session: string }>(`
    WITH bounds AS (
      SELECT CASE
        WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time >= TIME '15:30'
          THEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
        ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - 1
      END AS end_day
    )
    SELECT session_day::date::text AS session
    FROM bounds
    CROSS JOIN LATERAL generate_series(
      bounds.end_day - ($1::integer - 1),
      bounds.end_day,
      INTERVAL '1 day'
    ) AS sessions(session_day)
    WHERE EXTRACT(ISODOW FROM session_day) BETWEEN 1 AND 5
      AND NOT EXISTS (
        SELECT 1 FROM nse_holidays holiday WHERE holiday.holiday_date = session_day::date
      )
    ORDER BY session_day ASC
  `, [input.lookbackDays]);
  const expectedSessions = expectedResult.rows.map((row) => row.session);

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
        -- The expected-session calendar decides whether today is complete. Over-reading today's
        -- completed candles before the close is harmless because that date has no expected bucket yet.
        AND c.close_time >= (CURRENT_DATE - make_interval(days => $3))
        AND c.close_time < CURRENT_TIMESTAMP
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

    for (const day of expectedSessions) {
      const indices = bySession.get(day) ?? [];
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
