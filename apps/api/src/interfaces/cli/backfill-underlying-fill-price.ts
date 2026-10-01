import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

/**
 * One-off backfill for `paper_trades.underlying_fill_price` (migration 120).
 *
 * ## Why this is a backfill at all, unlike `underlying_exit_price`
 *
 * Migrations 089/090/091 deliberately never backfill an observed-price column, specifically so
 * that "non-null" can mean "this was actually observed in real time" without qualification. This
 * script breaks that pattern on purpose, for the same reason migration 120's own comment gives:
 * the field exists to correct a *measured* wrong diagnosis on already-closed historical trades,
 * and refusing to backfill would leave every trade before this fix permanently unreadable for the
 * one question it was added to answer. The provenance column (`underlying_fill_price_source`)
 * keeps the distinction migrations 089-091 were protecting: a reconstructed value is tagged
 * `BACKFILLED_NEAREST_TICK`, never conflated with a value observed live at the fill.
 *
 * ## Matching logic
 *
 * For each closed option trade with no `underlying_fill_price` yet, find the single
 * `option_premium_ticks` row nearest `opened_at` for the same contract (`underlying_symbol`,
 * `expiry_date`, `strike_price`, `option_type`) -- the same join used to empirically confirm the
 * defect against the live database. "Nearest" is absolute distance in either direction: `opened_at`
 * is the trade's actual fill instant, not a lower bound to search backward from (that asymmetry is
 * what the live fill path's own freshness gate needs; this script is reconstructing a single
 * instant after the fact, so the closest sample on either side is the best available estimate).
 *
 * ## Staleness tolerance
 *
 * Bounded to `MAXIMUM_EXECUTABLE_QUOTE_AGE_MS` (2 minutes) from `prepare-option-entry.ts` -- the
 * same window the live system itself requires between an observed ask and the fill it prices. A
 * backfilled value is only as trustworthy as a live one would have been at that same distance, so
 * reusing the live system's own freshness bar rather than inventing a looser one (the 40-minute
 * `MAXIMUM_CHAIN_AGE_MINUTES` governs OI/context usability, not point-in-time price correctness,
 * and is not an appropriate precedent here). A trade with no tick inside this window is left null
 * rather than filled from a tick far enough away to be a different market.
 */

/** See `apps/api/src/modules/paper-trading/application/prepare-option-entry.ts`. */
const MAXIMUM_BACKFILL_TICK_AGE_MS = 2 * 60 * 1000;

interface CandidateRow {
  trade_id: string;
  nearest_underlying_value: string | null;
  nearest_observed_at: Date | null;
  nearest_age_ms: string | null;
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const client = await database.connect();
  try {
    const candidates = await client.query<CandidateRow>(`
      SELECT
        trade.id AS trade_id,
        nearest.underlying_value AS nearest_underlying_value,
        nearest.observed_at AS nearest_observed_at,
        nearest.age_ms AS nearest_age_ms
      FROM paper_trades trade
      LEFT JOIN LATERAL (
        SELECT
          tick.underlying_value,
          tick.observed_at,
          ABS(EXTRACT(EPOCH FROM (tick.observed_at - trade.opened_at))) * 1000 AS age_ms
        FROM option_premium_ticks tick
        WHERE UPPER(tick.underlying_symbol) = UPPER(trade.underlying_symbol)
          AND tick.expiry_date = trade.option_expiry::date
          AND tick.strike_price = trade.option_strike
          AND tick.option_type = trade.option_type
          AND tick.underlying_value IS NOT NULL
        ORDER BY ABS(EXTRACT(EPOCH FROM (tick.observed_at - trade.opened_at)))
        LIMIT 1
      ) nearest ON TRUE
      WHERE trade.status = 'CLOSED'
        AND trade.underlying_fill_price IS NULL
        AND trade.option_strike IS NOT NULL
        AND trade.option_expiry IS NOT NULL
        AND trade.option_type IS NOT NULL
        AND trade.underlying_symbol IS NOT NULL
      ORDER BY trade.opened_at ASC
    `);

    let backfilled = 0;
    let noNearbyTick = 0;
    const skippedIds: string[] = [];

    for (const row of candidates.rows) {
      const ageMs = row.nearest_age_ms === null ? null : Number(row.nearest_age_ms);
      const underlyingValue = row.nearest_underlying_value === null
        ? null
        : Number(row.nearest_underlying_value);
      if (ageMs === null || underlyingValue === null || !Number.isFinite(underlyingValue)
        || ageMs > MAXIMUM_BACKFILL_TICK_AGE_MS) {
        noNearbyTick += 1;
        skippedIds.push(row.trade_id);
        continue;
      }

      await client.query(`
        UPDATE paper_trades
        SET underlying_fill_price = $2,
            underlying_fill_price_source = 'BACKFILLED_NEAREST_TICK'
        WHERE id = $1 AND underlying_fill_price IS NULL
      `, [row.trade_id, underlyingValue]);
      backfilled += 1;
    }

    console.log(JSON.stringify({
      level: "info",
      message: "underlying_fill_price backfill complete",
      candidates: candidates.rows.length,
      backfilled,
      noNearbyTick,
      staleToleranceMs: MAXIMUM_BACKFILL_TICK_AGE_MS,
      skippedTradeIds: skippedIds.slice(0, 20),
    }));
  } finally {
    client.release();
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
