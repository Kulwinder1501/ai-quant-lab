import type { Migration } from "../migration-runner.js";

// Relabels candles whose provider was recorded as 'seed'.
//
// `candles.source` records the provider the prices came from -- the ingestion paths
// set it from `provider.id`, which is how 'yahoo' gets there. Both seeds fetch from
// Yahoo through `yahoo-finance2` exactly like the real collector, but hardcoded
// `source = 'seed'`, describing how the row was written rather than where its prices
// originated. The result was 4374 rows of genuine Yahoo data on which the column that
// exists to identify real market data instead named the script that wrote it, so
// "which candles are real" could not be answered from it.
//
// The distinction is not lost, it moves to where it belongs: `source_metadata` gets
// `{"ingestedBy":"seed"}`, which is what that column is for. Existing metadata is
// merged rather than replaced, so any other keys survive.
//
// Only rows that say 'seed' are touched, and only their provenance columns -- no
// price, volume, or timestamp is altered.
export const correctSeedCandleProvenanceMigration: Migration = {
  id: "014-correct-seed-candle-provenance",
  sql: `
    UPDATE candles
    SET source = 'yahoo',
        source_metadata = source_metadata || '{"ingestedBy":"seed"}'::jsonb
    WHERE source = 'seed';
  `,
};
