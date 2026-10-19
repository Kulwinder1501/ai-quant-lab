import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  assessSessionCoverage,
  formatSessionCoverageLine,
  type BarCoverage,
  type ChainCoverage,
  type TickCoverage,
} from "../../modules/market-data/domain/session-coverage.js";

/**
 * Counts what one IST trading day left in the database and fails if it is short. Read-only.
 *
 *   npm run ops:session-coverage -- [--date YYYY-MM-DD]
 *
 * Exits non-zero on any gap, so the scheduler records the job as FAILED with the list of what is missing.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_FILTER = `
  (ts AT TIME ZONE 'Asia/Kolkata')::date = $1::date
  AND (ts AT TIME ZONE 'Asia/Kolkata')::time >= TIME '09:15'
  AND (ts AT TIME ZONE 'Asia/Kolkata')::time < TIME '15:30'`;

/** The series the platform trades or researches on, by symbol. Futures are found by name, since their contracts roll. */
const BAR_SERIES: ReadonlyArray<{ symbols: readonly string[]; timeframes: readonly string[] }> = [
  { symbols: ["NIFTY50", "BANKNIFTY"], timeframes: ["1m", "5m", "15m", "30m", "60m"] },
  { symbols: ["NIFTYBEES", "BANKBEES"], timeframes: ["1m", "5m"] },
  { symbols: ["INDIAVIX"], timeframes: ["1m", "5m", "15m"] },
];
const OPTION_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDate(argv: readonly string[]): string {
  const index = argv.indexOf("--date");
  if (index < 0) return istToday();
  const value = argv[index + 1];
  if (value === undefined || !DATE_PATTERN.test(value)) throw new Error("--date must be YYYY-MM-DD");
  return value;
}

async function readBars(database: DatabasePool, date: string): Promise<BarCoverage[]> {
  const result = await database.query(`
    SELECT i.symbol, c.timeframe, count(DISTINCT c.open_time)::int AS bars
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE c.is_complete
      AND ${SESSION_FILTER.replaceAll("ts", "c.open_time")}
      AND c.timeframe = ANY($2::text[])
      AND (i.symbol = ANY($3::text[]) OR i.symbol LIKE '%FUT')
    GROUP BY i.symbol, c.timeframe
  `, [date, ["1m", "5m", "15m", "30m", "60m"], BAR_SERIES.flatMap((entry) => entry.symbols)]);
  const found = new Map<string, number>();
  for (const row of result.rows as Array<{ symbol: string; timeframe: string; bars: number }>) {
    found.set(`${row.symbol}|${row.timeframe}`, row.bars);
  }

  const coverage: BarCoverage[] = [];
  for (const entry of BAR_SERIES) {
    for (const symbol of entry.symbols) {
      for (const timeframe of entry.timeframes) {
        coverage.push({ symbol, timeframe, bars: found.get(`${symbol}|${timeframe}`) ?? 0 });
      }
    }
  }
  // A futures contract is checked on 1m if it traded at all that day: an expired or not-yet-listed one has no bars
  // and is not a gap.
  for (const [key, bars] of found) {
    const [symbol, timeframe] = key.split("|") as [string, string];
    if (symbol.endsWith("FUT") && timeframe === "1m" && bars > 0) coverage.push({ symbol, timeframe, bars });
  }
  return coverage;
}

async function readChains(database: DatabasePool, date: string): Promise<ChainCoverage[]> {
  const result = await database.query(`
    SELECT underlying_symbol,
           count(DISTINCT date_trunc('minute', observed_at))::int AS snapshots,
           max(extract(hour FROM observed_at AT TIME ZONE 'Asia/Kolkata') * 60
             + extract(minute FROM observed_at AT TIME ZONE 'Asia/Kolkata'))::int AS last_minute
    FROM option_chain_snapshots
    WHERE ${SESSION_FILTER.replaceAll("ts", "observed_at")} AND underlying_symbol = ANY($2::text[])
    GROUP BY underlying_symbol
  `, [date, [...OPTION_UNDERLYINGS]]);
  const rows = result.rows as Array<{ underlying_symbol: string; snapshots: number; last_minute: number | null }>;
  return OPTION_UNDERLYINGS.map((underlying) => {
    const row = rows.find((entry) => entry.underlying_symbol === underlying);
    return { underlying, snapshots: row?.snapshots ?? 0, lastMinute: row?.last_minute ?? null };
  });
}

async function readTicks(database: DatabasePool, date: string): Promise<TickCoverage[]> {
  const result = await database.query(`
    SELECT underlying_symbol,
           count(DISTINCT date_trunc('minute', observed_at))::int AS minutes,
           max(extract(hour FROM observed_at AT TIME ZONE 'Asia/Kolkata') * 60
             + extract(minute FROM observed_at AT TIME ZONE 'Asia/Kolkata'))::int AS last_minute
    FROM option_premium_ticks
    WHERE ${SESSION_FILTER.replaceAll("ts", "observed_at")} AND underlying_symbol = ANY($2::text[])
    GROUP BY underlying_symbol
  `, [date, [...OPTION_UNDERLYINGS]]);
  const rows = result.rows as Array<{ underlying_symbol: string; minutes: number; last_minute: number | null }>;
  return OPTION_UNDERLYINGS.map((underlying) => {
    const row = rows.find((entry) => entry.underlying_symbol === underlying);
    return { underlying, minutesWithTicks: row?.minutes ?? 0, lastMinute: row?.last_minute ?? null };
  });
}

async function readDepthFrames(database: DatabasePool, date: string): Promise<number> {
  const result = await database.query(`
    SELECT count(*)::int AS frames FROM depth_frames
    WHERE ${SESSION_FILTER.replaceAll("ts", "received_at")}
  `, [date]);
  return Number((result.rows[0] as { frames: number } | undefined)?.frames ?? 0);
}

async function main(): Promise<void> {
  const date = parseDate(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const [bars, chains, ticks, depthFrames] = await Promise.all([
      readBars(database, date),
      readChains(database, date),
      readTicks(database, date),
      readDepthFrames(database, date),
    ]);
    const verdict = assessSessionCoverage({ date, bars, chains, ticks, depthFrames });
    const line = formatSessionCoverageLine(date, verdict);
    if (verdict.ok) {
      console.info(line);
    } else {
      console.error(line);
      process.exitCode = 1;
    }
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Session coverage check failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
