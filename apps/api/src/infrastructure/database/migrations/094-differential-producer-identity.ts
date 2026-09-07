import type { Migration } from "../migration-runner.js";

/**
 * Makes the deciding producer part of a differential observation's identity.
 *
 * ## The defect, found by looking at the table after a day of runs
 *
 * Two rows, both written by the first native pass. Every run afterwards -- native *and* ported --
 * reported `observationRecorded: false`, because `(comparison_key, comparison_version)` already
 * existed and the insert is `ON CONFLICT DO NOTHING`.
 *
 * `comparison_version` names the *canonicalisation* (`THESIS_COMPARISON_V1` quantises prices to two
 * decimals); it says nothing about which rule decided. So two V2.2 producers evaluating the same bar
 * competed for one row, the first writer won, and the second was discarded in silence. The ported
 * producer -- the entire point of which is to supply P13's decisive comparisons -- could never have
 * contributed a single row while the scheduler ran the native one first.
 *
 * It is the failure the flag-parse fix warned about one commit earlier, in the same table: a run
 * mislabelled at the source puts two rules' decisions into one population. Here it was worse than
 * mislabelling -- the second rule's decisions were dropped entirely.
 *
 * ## So `producer_id` joins the key
 *
 * One observation per (decision point, canonicalisation, producer). Native's abstention and the ported
 * rule's answer are different facts about the same bar, and P13 must be able to hold both and grade
 * them separately -- a verdict pooled across producers would average a rule that claims nothing with a
 * rule that trades.
 *
 * The two existing rows were written by the native producer, so the column arrives with its id as a
 * DEFAULT and the default is then dropped. That is the same route migration 091 took, and for the same
 * reason: the table is append-only by trigger, so a `NOT NULL` column cannot be backfilled by `UPDATE`
 * without suspending the guard. Here it needs no suspension at all -- the default is correct for every
 * row that exists.
 */
export const differentialProducerIdentityMigration: Migration = {
  id: "094-differential-producer-identity",
  sql: `
    ALTER TABLE differential_observations
      ADD COLUMN IF NOT EXISTS producer_id TEXT NOT NULL DEFAULT 'structural-gate-v1';
    ALTER TABLE differential_observations ALTER COLUMN producer_id DROP DEFAULT;
    ALTER TABLE differential_observations
      ADD CONSTRAINT differential_observations_producer_named
      CHECK (length(trim(producer_id)) > 0) NOT VALID;
    ALTER TABLE differential_observations VALIDATE CONSTRAINT differential_observations_producer_named;

    ALTER TABLE differential_observations
      DROP CONSTRAINT IF EXISTS differential_observations_unique_comparison;
    ALTER TABLE differential_observations
      ADD CONSTRAINT differential_observations_unique_comparison
      UNIQUE (comparison_key, comparison_version, producer_id);

    -- Divergences are read per producer, so the producer leads the index the selective reads use.
    DROP INDEX IF EXISTS differential_observations_divergent_idx;
    CREATE INDEX IF NOT EXISTS differential_observations_divergent_idx
      ON differential_observations (comparison_version, producer_id, recorded_at DESC) WHERE NOT agreed;

    COMMENT ON COLUMN differential_observations.producer_id IS
      'Which V2.2 producer decided: structural-gate-v1 (native, claims no edge) or '
      'ported-v1@PORTED_V1_THESIS_POLICY_V1 (V1 rule through the V2.2 port, differential only). Part '
      'of the unique key -- without it two producers competed for one row and the second was silently '
      'dropped by ON CONFLICT DO NOTHING. See migration 094.';
  `,
};
