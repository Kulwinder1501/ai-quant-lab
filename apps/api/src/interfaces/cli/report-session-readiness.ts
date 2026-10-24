import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  STORED_FRAME_COLUMNS,
  toStoredFrame,
  type StoredFrameRow,
} from "../../infrastructure/database/repositories/postgres-depth-frame-repository.js";
import {
  buildReadiness,
  formatReadiness,
  type ChainRunsInput,
  type DepthSessionInput,
  type LotInput,
  type VendorGreeksInput,
} from "../../modules/market-data/domain/session-readiness.js";

/**
 * What one IST trading day left in the database for the open checks of the 2026-10-24 deploy, with the rule each is judged by. Read-only.
 *
 *   npm run ops:session-readiness -- [--date YYYY-MM-DD]
 *
 * Prints a report and exits 0: a CHECK is something to read, not a failed job. (`ops:session-coverage` is the one that fails.)
 * Run it for an earlier date to compare, for instance a 10-level depth day against the first 50-level one.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_FILTER = `
  (ts AT TIME ZONE 'Asia/Kolkata')::date = $1::date
  AND (ts AT TIME ZONE 'Asia/Kolkata')::time >= TIME '09:15'
  AND (ts AT TIME ZONE 'Asia/Kolkata')::time < TIME '15:30'`;
const inSession = (column: string) => SESSION_FILTER.replaceAll("ts", column);

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;
const VENDOR_PRESENT = "(vendor_delta IS NOT NULL OR vendor_gamma IS NOT NULL OR vendor_theta IS NOT NULL OR vendor_vega IS NOT NULL OR vendor_iv_percent IS NOT NULL)";
/**
 * The depth frames are read whole only for a sample: the frames whose second-of-day is a multiple of this. That is a deterministic
 * slice of the session (not the first N rows, which would be the open), about a twentieth of the frames, and every frame within a
 * chosen second is included.
 */
const SAMPLE_SECOND_MODULUS = 20;
const SAMPLE_LIMIT = 6_000;

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

async function readDepth(database: DatabasePool, date: string): Promise<DepthSessionInput[]> {
  const summary = await database.query(`
    SELECT provider_symbol,
           count(*)::int AS frames,
           count(*) FILTER (WHERE levels_stored >= LEAST(levels_available, 50))::int AS untruncated_frames,
           count(*) FILTER (WHERE levels_available >= 50)::int AS carrying_full_frames,
           count(*) FILTER (WHERE levels_stored = 50)::int AS full_frames,
           max(levels_stored)::int AS max_stored,
           max(levels_available)::int AS max_available
    FROM depth_frames
    WHERE ${inSession("received_at")}
    GROUP BY provider_symbol
    ORDER BY provider_symbol
  `, [date]);
  const symbols = summary.rows as Array<{ provider_symbol: string; frames: number; untruncated_frames: number; carrying_full_frames: number; full_frames: number; max_stored: number | null; max_available: number | null }>;
  const result: DepthSessionInput[] = [];
  for (const symbol of symbols) {
    const sample = await database.query(`
      SELECT ${STORED_FRAME_COLUMNS}
      FROM depth_frames
      WHERE ${inSession("received_at")}
        AND provider_symbol = $2
        AND (floor(extract(epoch FROM received_at))::bigint % ${SAMPLE_SECOND_MODULUS}) = 0
      ORDER BY received_at
      LIMIT ${SAMPLE_LIMIT}
    `, [date, symbol.provider_symbol]);
    result.push({
      providerSymbol: symbol.provider_symbol,
      frames: symbol.frames,
      framesUntruncated: symbol.untruncated_frames,
      framesCarryingFullDepth: symbol.carrying_full_frames,
      framesWithFullDepth: symbol.full_frames,
      maxLevelsStored: symbol.max_stored,
      maxLevelsAvailable: symbol.max_available,
      sample: (sample.rows as StoredFrameRow[]).map(toStoredFrame),
    });
  }
  return result;
}

async function readVendor(database: DatabasePool, date: string): Promise<VendorGreeksInput[]> {
  const result = await database.query(`
    SELECT underlying_symbol,
           count(DISTINCT observed_at)::int AS snapshots,
           count(DISTINCT observed_at) FILTER (WHERE ${VENDOR_PRESENT})::int AS snapshots_with_vendor,
           count(*)::int AS rows,
           count(*) FILTER (WHERE ${VENDOR_PRESENT})::int AS rows_with_vendor
    FROM option_chain_snapshots
    WHERE ${inSession("observed_at")} AND underlying_symbol = ANY($2::text[])
    GROUP BY underlying_symbol
  `, [date, [...UNDERLYINGS]]);
  const found = result.rows as Array<{ underlying_symbol: string; snapshots: number; snapshots_with_vendor: number; rows: number; rows_with_vendor: number }>;
  return UNDERLYINGS.map((underlying) => {
    const row = found.find((entry) => entry.underlying_symbol === underlying);
    return {
      underlying,
      snapshots: row?.snapshots ?? 0,
      snapshotsWithVendor: row?.snapshots_with_vendor ?? 0,
      rows: row?.rows ?? 0,
      rowsWithVendor: row?.rows_with_vendor ?? 0,
    };
  });
}

async function readChainRuns(database: DatabasePool, date: string): Promise<ChainRunsInput> {
  const result = await database.query(`
    SELECT error_details
    FROM scheduled_job_runs
    WHERE job_type = 'OPTION_CHAIN'
      AND status = 'COMPLETED'
      AND (scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = $1::date
  `, [date]);
  const rows = result.rows as Array<{ error_details: string | null }>;
  return { completedRuns: rows.length, notes: rows.map((row) => row.error_details) };
}

async function readLots(database: DatabasePool, date: string): Promise<LotInput[]> {
  const result = await database.query(`
    SELECT i.symbol,
           i.lot_size::int AS lot_size,
           count(*)::int AS trades,
           count(*) FILTER (WHERE pt.quantity % i.lot_size <> 0)::int AS off_lot
    FROM paper_trades pt
    JOIN instruments i ON i.id = pt.instrument_id
    WHERE (pt.opened_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      AND pt.status <> 'CANCELLED'
      AND i.lot_size > 1
    GROUP BY i.symbol, i.lot_size
    ORDER BY i.symbol
  `, [date]);
  return (result.rows as Array<{ symbol: string; lot_size: number; trades: number; off_lot: number }>).map((row) => ({
    symbol: row.symbol,
    lotSize: row.lot_size,
    trades: row.trades,
    offLot: row.off_lot,
  }));
}

async function main(): Promise<void> {
  const date = parseDate(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const [depth, vendor, chainRuns, lots] = await Promise.all([
      readDepth(database, date),
      readVendor(database, date),
      readChainRuns(database, date),
      readLots(database, date),
    ]);
    for (const line of formatReadiness(date, buildReadiness({ date, depth, vendor, chainRuns, lots }))) console.info(line);
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Session readiness report failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
