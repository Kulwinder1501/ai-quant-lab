import type { Migration } from "../migration-runner.js";

// Removes SMC snapshots computed by indicator code that read the future.
//
// Three of the six smart-money indicators were not point-in-time, each in its own way:
//
// * **FVG** detected a three-bar gap using bar i and stamped it on bar **i-1**, so a value
//   published at i-1 was computed from i.
// * **EQUILIBRIUM_ZONE** published its zone on the same bar whose swing had just been
//   confirmed, and confirming a swing reads the following `pivotLength` bars. Unlike BOS and
//   LIQUIDITY_SWEEP -- whose trigger is a break of the level, which cannot occur inside the
//   confirmation window -- it emitted unconditionally, so nothing protected it.
// * **ORDER_BLOCK** measured displacement against a mean seeded from the series' first fifty
//   candles regardless of where it was scoring, and the seed's influence decays without ever
//   leaving.
//
// All three were measured, not inferred: editing a later bar changed earlier published
// values. `smc-indicators.test.ts` now asserts the property for all six and fails if any
// regresses.
//
// The stored rows predate those fixes, so they carry the look-ahead. Deleting them is right
// rather than merely tidy: they are currently drawn on charts and listed by the scanner, and
// the feature schema is one entry away from consuming them. Recomputation is the ordinary
// `analysis:calculate-indicators` run and costs nothing that was not going to be recomputed
// anyway.
//
// BOS, CHOCH and LIQUIDITY_SWEEP are left alone: their logic is unchanged and the sweep
// confirms they were already clean.
export const purgeLookAheadSmcSnapshotsMigration: Migration = {
  id: "048-purge-look-ahead-smc-snapshots",
  sql: `
    DELETE FROM indicator_snapshots
    WHERE indicator_definition_id IN (
      SELECT id FROM indicator_definitions
      WHERE indicator_code IN ('FVG', 'EQUILIBRIUM_ZONE', 'ORDER_BLOCK')
    );
  `,
};
