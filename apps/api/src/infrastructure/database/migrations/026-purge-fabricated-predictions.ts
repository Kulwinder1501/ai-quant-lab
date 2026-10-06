import type { Migration } from "../migration-runner.js";

// Purges the fabricated model_predictions rows left behind by the removed seed path.
//
// Every prediction written before this migration (110 rows at authoring time, verified
// 110 of 110) carries the seed's hardcoded explanation payload: a feature contribution
// of exactly 0.421 and a linearScore of exactly 0.856. None of them came from a real
// inference run, so none of them says anything about any model.
//
// This matters more now than when they were written: migration 025 added settlement
// (settled_at / realized_label / was_correct), and the EOD pipeline settles every
// unsettled prediction whose horizon has closed. Left in place, these rows would be
// settled like real ones and become the first live-accuracy figures the project has
// ever produced -- numbers built entirely out of invented data, indistinguishable from
// measurements. Deleting them is the only honest option; the settlement layer starts
// from zero and every row it ever scores will be a genuine inference.
//
// The fingerprint match is safe at migration time: no real inference writes literal
// 0.421 contributions or 0.856 scores as constants, and this runs before the scheduled
// predict step has produced any organic rows. Nothing references model_predictions.id,
// and none of these rows is settled, so no derived data is lost.
export const purgeFabricatedPredictionsMigration: Migration = {
  id: "026-purge-fabricated-predictions",
  sql: `
    DELETE FROM model_predictions
    WHERE feature_contributions::text LIKE '%0.421%'
       OR explanation::text LIKE '%0.856%';
  `,
};
