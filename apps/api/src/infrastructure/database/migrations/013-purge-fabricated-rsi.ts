import type { Migration } from "../migration-runner.js";

// Deletes the RSI snapshots left behind by the random-RSI seeds.
//
// Both seeds used to write `Math.floor(40 + Math.random() * 30)` into
// `indicator_snapshots` as a measured RSI. The code now computes a real
// simple-average RSI, but re-running the seeds only rewrites the candles currently
// inside their fetch window; on this database that left 379 fabricated rows on 1m
// candles from earlier runs, which no later seed run will ever revisit.
//
// The fabricated rows are identified by that generator's signature: a whole number
// in [40, 70). A genuine RSI stored to two decimals lands on an exact integer only
// rarely, so this predicate may also remove a small number of real values. That is
// an acceptable trade -- these are `v1` seed rows whose stated purpose is only to
// keep demo candles from being bare, they are regenerable by re-running the seed,
// and the production contract the strategies read is `ta-v1`, which this does not
// touch.
//
// Scoped to RSI. The seeds' other `v1` indicators (SMA, Bollinger, EMA, VWAP) were
// always computed from real closes.
export const purgeFabricatedRsiMigration: Migration = {
  id: "013-purge-fabricated-rsi",
  sql: `
    DELETE FROM indicator_snapshots
    WHERE id IN (
      SELECT indicator_snapshots.id
      FROM indicator_snapshots
      JOIN indicator_definitions
        ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
      WHERE indicator_definitions.indicator_code = 'RSI'
        AND indicator_definitions.algorithm_version = 'v1'
        AND (indicator_snapshots.values->>'value') ~ '^[0-9]+(\\.0+)?$'
        AND (indicator_snapshots.values->>'value')::numeric >= 40
        AND (indicator_snapshots.values->>'value')::numeric < 70
    );
  `,
};
