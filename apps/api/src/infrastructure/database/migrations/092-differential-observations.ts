import type { Migration } from "../migration-runner.js";

/**
 * Stores P13's paired observations, so the differential record accumulates across sessions.
 *
 * Brain P13 grades V1 against V2.2 before V1 may be retired, and a verdict from a single run is
 * worth little — `evaluateDifferentialRun` deliberately refuses to call an empty run promotable, and
 * one afternoon's pairs are barely better than empty. The evidence has to build up somewhere.
 *
 * ## Both sides cite one snapshot, and the FK enforces it
 *
 * `assertComparable` refuses a comparison whose two sides read different snapshots: if they saw
 * different worlds, a difference in their answers is uninterpretable. The composite FK to
 * `decision_snapshots` — matching `decision_ledger`'s — carries that further, by refusing a stored
 * observation whose snapshot nobody kept. An observation pointing at an absent context could not be
 * re-derived, and an ungradeable row sitting among gradeable ones inflates the count P13 reads.
 *
 * How one snapshot can honestly describe both sides: the shadow pass evaluates V1's strategies
 * against **the same `StrategyMarketContext`** it sealed the snapshot from. V1 never reads a sealed
 * snapshot itself, so pairing on "the same bar" would have been a weaker claim — contexts are
 * enriched over time as pattern layers backfill, and two reads of one bar are not always equal. Both
 * outcomes here come from one in-memory context, read once.
 *
 * ## `agreed` is generated, not written
 *
 * A stored boolean beside the two strings it summarises is a drift waiting to happen: an
 * `INSERT` that sets it wrongly, or a later change to what equality means, and the column disagrees
 * with the data it describes. `GENERATED ALWAYS AS … STORED` makes that unrepresentable, and it costs
 * nothing — the comparison is string equality, which is exactly what P13 does in code.
 *
 * ## Append-only, and unique per comparison
 *
 * A research record, so the same rule as `study_trials` and `decision_ledger`: no UPDATE, no DELETE.
 * The unique constraint on `(comparison_key, comparison_version)` makes a re-run idempotent rather
 * than duplicating — the shadow pass may legitimately re-evaluate a bar, and P13 counts rows.
 *
 * The version is part of that key deliberately. `THESIS_COMPARISON_V1` decides what counts as equal
 * (it quantises prices to two decimals), so observations under a later version are a different
 * population and must be able to coexist rather than collide.
 */
export const differentialObservationsMigration: Migration = {
  id: "092-differential-observations",
  sql: `
    CREATE TABLE IF NOT EXISTS differential_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- instrument@instant. Identifies the decision point both systems were asked about.
      comparison_key TEXT NOT NULL CHECK (length(trim(comparison_key)) > 0),
      -- Which canonicalisation produced the two outcomes; it decides what counts as equal.
      comparison_version TEXT NOT NULL CHECK (length(trim(comparison_version)) > 0),
      context_encoding_version TEXT NOT NULL,
      context_snapshot_id TEXT NOT NULL,
      legacy_outcome TEXT NOT NULL CHECK (length(trim(legacy_outcome)) > 0),
      v2_outcome TEXT NOT NULL CHECK (length(trim(v2_outcome)) > 0),
      -- Derived, never supplied: a written boolean beside the strings it summarises can drift.
      agreed BOOLEAN GENERATED ALWAYS AS (legacy_outcome = v2_outcome) STORED,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT differential_observations_unique_comparison
        UNIQUE (comparison_key, comparison_version),
      -- Both sides read this snapshot. Refusing an absent one keeps every stored row re-derivable.
      CONSTRAINT differential_observations_snapshot_resolvable
        FOREIGN KEY (context_encoding_version, context_snapshot_id)
        REFERENCES decision_snapshots (encoding_version, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS differential_observations_recorded_idx
      ON differential_observations (recorded_at DESC);

    -- Divergences are the rows P13 grades, so they are the ones read most selectively.
    CREATE INDEX IF NOT EXISTS differential_observations_divergent_idx
      ON differential_observations (comparison_version, recorded_at DESC) WHERE NOT agreed;

    CREATE OR REPLACE FUNCTION reject_differential_observation_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION
        'differential_observations is append-only: % on a stored observation is refused. A '
        'comparison is a record of what two systems said at one instant; editing it rewrites the '
        'evidence P13 grades. Record a new observation under a new comparison_version instead.',
        TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS differential_observations_reject_mutation ON differential_observations;
    CREATE TRIGGER differential_observations_reject_mutation
      BEFORE UPDATE OR DELETE ON differential_observations
      FOR EACH ROW EXECUTE FUNCTION reject_differential_observation_mutation();

    COMMENT ON TABLE differential_observations IS
      'Brain P13 paired observations: what V1 and V2.2 each decided at one instant, both from the '
      'same sealed context. Append-only. agreed is generated from the two outcomes. Rows under '
      'different comparison_version values are different populations and are not comparable, '
      'because the version decides what counts as equal. See migration 092.';
  `,
};
