import type { Migration } from "../migration-runner.js";

/**
 * Binds a trial to the exact dataset it ran on, not merely to the span of sessions it covered.
 *
 * Migration 081 recorded `session_range_start`, `session_range_end` and `session_count`. Those identify a
 * *range*, and two genuinely different session sets can share all three. More pressingly for this system,
 * they cannot see a dataset change *inside* a session that was already counted — and two inputs here are
 * mutable in exactly that way:
 *
 *   - the nightly candle healer appends repaired bars to sessions already stored;
 *   - `indicator_snapshots` is rewritten wholesale by recompute passes, and every decision's ATR — the
 *     volatility scale the ATR-unit figures divide by — is read from it.
 *
 * Without these columns a healed dataset yields the same trial key and a different result, which the
 * ledger reports as a `DETERMINISM_VIOLATION` even though nothing nondeterministic happened. The input
 * changed, and that deserves to be a new legitimate execution rather than an alarm.
 *
 * `dataset_cutoff` stays where it is and stays out of scientific identity: it records when the query ran,
 * which is audit metadata. Three identities are now separately frozen — declared policy
 * (`study_definition_hash`), implementation (`code_version`) and dataset (these two).
 *
 * Nullable, because the append-only trigger forbids backfilling and inventing a digest for the 108 trials
 * already recorded would assert exactly the fact these columns exist to establish. Null reads as
 * "declared before dataset identity was captured", which is true.
 */
export const scalpResearchTrialDatasetIdentityMigration: Migration = {
  id: "082-scalp-research-trial-dataset-identity",
  sql: `
    ALTER TABLE research_scalp.study_trials
      ADD COLUMN IF NOT EXISTS session_set_hash CHAR(64)
        CHECK (session_set_hash IS NULL OR session_set_hash ~ '^[0-9a-f]{64}$'),
      ADD COLUMN IF NOT EXISTS input_snapshot_hash CHAR(64)
        CHECK (input_snapshot_hash IS NULL OR input_snapshot_hash ~ '^[0-9a-f]{64}$');

    COMMENT ON COLUMN research_scalp.study_trials.session_set_hash IS
      'Digest of the exact ordered session set. Null for trials declared before migration 082.';
    COMMENT ON COLUMN research_scalp.study_trials.input_snapshot_hash IS
      'Digest of the decision rows and bars the walk actually read, so healed or recomputed source data '
      'becomes a new dataset identity rather than a determinism alarm.';
  `,
};
