import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

/**
 * Deletes `depth_frames` rows older than a caller-chosen cutoff.
 *
 * Why this exists: `depth_frames` cannot be backfilled (an L2 update not received when it
 * happened is gone for good, per depth-frame-staleness.ts's own module doc), so there has never
 * been a retention policy -- the table has only ever grown. At 2026-10-06 it is 1.4GB / 1.25M
 * rows for 46 days of BANKNIFTY-only capture (~30MB/day). Adding a second underlying roughly
 * doubles that rate. Not urgent at today's size, but unbounded growth with no release valve
 * becomes somebody's incident eventually, and the honest fix is a deliberate, auditable prune --
 * not an ad hoc DELETE run by hand under pressure the day the disk actually fills up.
 *
 * Same safety shape as purge-yahoo-scalp-candles.ts: dry run by default, reporting exactly what
 * would be removed (per symbol, with the oldest/newest timestamp in that set) before anything is
 * deleted; `--apply` is required to actually delete. `--older-than-days` has no default and must
 * clear a 30-day floor, so a mistyped or omitted value cannot silently erase the whole table --
 * the cost of getting this wrong is unrecoverable, unlike almost everything else this project
 * prunes.
 *
 * Usage:
 *   prune-depth-frames --older-than-days=90            (dry run: reports only)
 *   prune-depth-frames --older-than-days=90 --apply     (actually deletes)
 */

const MINIMUM_RETENTION_DAYS = 30;

interface Options {
  olderThanDays: number;
  apply: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }

  const apply = argv.includes("--apply");
  const raw = values.get("older-than-days");
  if (raw === undefined) {
    throw new Error(
      "--older-than-days is required, for example --older-than-days=90. There is no default: "
      + "depth_frames cannot be backfilled, so the retention window is a deliberate choice, "
      + "never an assumed one.",
    );
  }
  const olderThanDays = Number(raw);
  if (!Number.isFinite(olderThanDays) || olderThanDays < MINIMUM_RETENTION_DAYS) {
    throw new Error(
      `--older-than-days must be a number >= ${MINIMUM_RETENTION_DAYS}. Refusing a smaller value `
      + "rather than risk deleting data a research window still needs; this floor is an "
      + "operational safety minimum, not a tuned retention policy.",
    );
  }

  return { olderThanDays, apply };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const cutoff = new Date(Date.now() - options.olderThanDays * 24 * 60 * 60 * 1_000);

    const survey = await database.query<{
      provider_symbol: string; rows_to_delete: string; oldest: Date; newest: Date;
    }>(
      `SELECT provider_symbol,
              count(*) AS rows_to_delete,
              min(received_at) AS oldest,
              max(received_at) AS newest
       FROM depth_frames
       WHERE received_at < $1
       GROUP BY provider_symbol
       ORDER BY provider_symbol`,
      [cutoff],
    );

    const sizeBefore = await database.query<{ pretty: string }>(
      `SELECT pg_size_pretty(pg_total_relation_size('depth_frames')) AS pretty`,
    );

    const totalRowsToDelete = survey.rows.reduce((sum, row) => sum + Number(row.rows_to_delete), 0);

    console.info(JSON.stringify({
      level: "info",
      message: options.apply ? "Pruning depth_frames" : "Dry run -- nothing deleted",
      cutoff: cutoff.toISOString(),
      olderThanDays: options.olderThanDays,
      tableSizeBeforePrune: sizeBefore.rows[0]?.pretty,
      totalRowsToDelete,
      bySymbol: survey.rows.map((row) => ({
        providerSymbol: row.provider_symbol,
        rowsToDelete: Number(row.rows_to_delete),
        oldestInDeletedRange: row.oldest.toISOString(),
        newestInDeletedRange: row.newest.toISOString(),
      })),
    }));

    if (!options.apply) {
      console.info("Re-run with --apply to delete. Nothing has been removed.");
      return;
    }

    if (totalRowsToDelete === 0) {
      console.info("Nothing older than the cutoff; no delete issued.");
      return;
    }

    const deleted = await database.query(
      `DELETE FROM depth_frames WHERE received_at < $1`,
      [cutoff],
    );

    const sizeAfter = await database.query<{ pretty: string }>(
      `SELECT pg_size_pretty(pg_total_relation_size('depth_frames')) AS pretty`,
    );

    console.info(JSON.stringify({
      level: "info",
      message: "depth_frames pruned",
      rowsDeleted: deleted.rowCount ?? 0,
      tableSizeAfterPrune: sizeAfter.rows[0]?.pretty,
      note: "Postgres does not shrink the file on DELETE; a VACUUM (not run here) reclaims the "
        + "freed space for reuse but the on-disk size will not drop until one runs.",
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
