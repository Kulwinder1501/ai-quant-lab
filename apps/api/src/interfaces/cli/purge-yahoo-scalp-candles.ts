import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

/**
 * Deletes the Yahoo-sourced scalp candles so a Fyers backfill can own those
 * timeframes.
 *
 * Deliberately a CLI command and not a migration. Migrations always run once
 * registered, and this deletion is conditional on something a migration cannot check:
 * that Fyers has actually replaced the range. `migration-runner.test.ts` also requires
 * migration IDs to be gapless and match their array index, so a
 * registered-but-inert migration is not expressible here anyway.
 *
 * Why it is needed at all: `PostgresCandleRepository.upsert` treats completed candles
 * as immutable and includes `source` in its equality check. Backfilling Fyers over a
 * range Yahoo already covers therefore either aborts on the first overlapping bar
 * (loud, harmless) or — with `--skip-existing` — keeps every Yahoo bar and drops every
 * Fyers bar while reporting success and writing an ingestion row labelled
 * `fyers-api-v3`. The second is the dangerous one: it looks exactly like a successful
 * migration. Observed on 2026-08-03, when a NIFTY50 5m probe fetched 825 bars and
 * persisted none of them.
 *
 * Dry run by default. `--apply` is required to delete, and `indicator_snapshots`
 * cascades on `candle_id`, so indicators must be recomputed over the Fyers range after.
 */
const SCALP_TIMEFRAMES = ["1m", "3m", "5m", "10m"];

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const apply = argumentsList.includes("--apply");
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const survey = await database.query(
      `SELECT c.timeframe,
              count(*) AS yahoo_bars,
              count(*) FILTER (WHERE f.open_time IS NOT NULL) AS fyers_replacement
       FROM candles c
       LEFT JOIN candles f
         ON f.instrument_id = c.instrument_id
        AND f.timeframe = c.timeframe
        AND f.open_time = c.open_time
        AND f.source = 'fyers-api-v3'
       WHERE c.source = 'yahoo' AND c.timeframe = ANY($1)
       GROUP BY c.timeframe
       ORDER BY c.timeframe`,
      [SCALP_TIMEFRAMES],
    );

    const snapshots = await database.query(
      `SELECT count(*) AS n
       FROM indicator_snapshots s
       JOIN candles c ON c.id = s.candle_id
       WHERE c.source = 'yahoo' AND c.timeframe = ANY($1)`,
      [SCALP_TIMEFRAMES],
    );

    console.info(JSON.stringify({
      level: "info",
      message: apply ? "Purging Yahoo scalp candles" : "Dry run — nothing deleted",
      timeframes: survey.rows.map((row) => ({
        timeframe: String(row.timeframe),
        yahooBars: Number(row.yahoo_bars),
        // A timeframe with no Fyers replacement would be left empty by this purge.
        fyersAlreadyCovering: Number(row.fyers_replacement),
      })),
      indicatorSnapshotsCascading: Number(snapshots.rows[0]?.n ?? 0),
    }));

    if (!apply) {
      console.info("Re-run with --apply to delete. Recompute indicators over the Fyers range afterwards.");
      return;
    }

    const deleted = await database.query(
      "DELETE FROM candles WHERE source = 'yahoo' AND timeframe = ANY($1)",
      [SCALP_TIMEFRAMES],
    );
    console.info(JSON.stringify({
      level: "info",
      message: "Yahoo scalp candles purged",
      candlesDeleted: deleted.rowCount ?? 0,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
