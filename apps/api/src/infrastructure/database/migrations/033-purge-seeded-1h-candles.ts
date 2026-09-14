import type { Migration } from "../migration-runner.js";

/**
 * Removes the seeded `1h` candles, which duplicated `60m` under a name nothing can
 * produce.
 *
 * `1h` is not a member of `supportedHistoricalTimeframes`, so no collector emits it. The
 * only rows that ever carried it came from `seed-market-data.ts`, and every stored row
 * was `source_metadata->>'ingestedBy' = 'seed'` when this migration was written: 108
 * candles across NIFTY50 and BANKNIFTY, with 466 dependent `indicator_snapshots`.
 *
 * They were not harmless. `postgres-trade-review-repository.ts` ranked timeframes finest
 * first and listed `1h` but not `60m`, so every trade review looked for these 108
 * fabricated bars while 78,000 real `60m` bars sat under the canonical name — and fell
 * through to `1d` whenever the seed bars did not span the holding period, silently
 * loosening the MAE/MFE bound to a whole daily range. That ladder now reads `60m` (and
 * `30m`, which was missing despite 11,846 stored bars), which leaves these rows
 * unreferenced.
 *
 * 84 of the 108 sit at open times that match a real `60m` bar; the remaining 24 do not,
 * and 18 are not even on the `:45` session grid — seed interval arithmetic rather than
 * market observations. Deleting them therefore removes fabricated evidence, not coverage,
 * which is the same reasoning as `013-purge-fabricated-rsi` and
 * `026-purge-fabricated-predictions`.
 *
 * A registered migration rather than an operator command, unlike the Yahoo scalp purge:
 * this deletion is unconditional and correct on every database, with no external
 * precondition to check.
 *
 * `indicator_snapshots.candle_id` is ON DELETE CASCADE, so the dependent snapshots go
 * with the candles.
 */
export const purgeSeeded1hCandlesMigration: Migration = {
  id: "033-purge-seeded-1h-candles",
  sql: `
    DELETE FROM candles
    WHERE timeframe = '1h'
      AND source_metadata ->> 'ingestedBy' = 'seed';
  `,
};
