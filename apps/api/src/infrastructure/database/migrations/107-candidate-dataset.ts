import type { Migration } from "../migration-runner.js";

/**
 * Stores P6b's Candidate Dataset: the rejected sides a rejected thesis produces.
 *
 * `thesis-builder.ts`'s `toCandidateDatasetEntry` has existed since P6b as type and mapping only --
 * a documented target shape with nowhere to put a row. This is that store, following
 * `differential_observations` (migration 092) almost exactly: an append-only research record, FK'd to
 * the same sealed `decision_snapshots` context, so every row stays re-derivable (I20).
 *
 * ## Why `entry_id` alone is the idempotency key
 *
 * Unlike `differential_observations`' composite `(comparison_key, comparison_version, producer_id)`
 * uniqueness, `CandidateDatasetEntry.entryId` is already a `logicalKey` -- a content hash over every
 * field that identifies the row (`instrumentSymbol`, `decisionAt`, `side`, `refusal`,
 * `observedIn.snapshotId`). Two thesis-builder runs over the same rejected side produce the identical
 * id, so the primary key itself is the idempotency boundary; `ON CONFLICT (entry_id) DO NOTHING` needs
 * no second column to reference.
 *
 * ## `side` and `refusal` are CHECK-constrained, not free text
 *
 * Both are closed TypeScript unions today (`ThesisSide`, `SideRefusal`), and this table's only
 * legitimate writer is `toCandidateDatasetEntry`'s output. A `CHECK IN (...)` is a real safety net here,
 * the same posture `decision_snapshots.snapshot_id`'s hex-pattern CHECK takes -- not an over-restriction,
 * since a genuinely new refusal reason is a domain change that should ship its own migration to widen
 * this constraint, the same cost every CHECK enum in this codebase already carries.
 *
 * ## Append-only, enforced by trigger
 *
 * Same rationale as `differential_observations`/`decision_snapshots`: a row here is evidence of what
 * happened at one decision instant -- which side was rejected, and why -- and editing it rewrites that
 * evidence out from under whatever later reads it.
 */
export const candidateDatasetMigration: Migration = {
  id: "107-candidate-dataset",
  sql: `
    CREATE TABLE IF NOT EXISTS candidate_dataset_entries (
      -- logicalKey over instrumentSymbol/decisionAt/side/refusal/observedIn.snapshotId; the identity
      -- is content-addressed, so this column alone is the idempotency key.
      entry_id CHAR(64) PRIMARY KEY CHECK (entry_id ~ '^[0-9a-f]{64}$'),
      instrument_symbol TEXT NOT NULL CHECK (length(trim(instrument_symbol)) > 0),
      decision_at TIMESTAMPTZ NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      refusal TEXT NOT NULL CHECK (refusal IN ('NO_ORIENTATION_EVIDENCE', 'DEGENERATE_GEOMETRY')),
      context_encoding_version TEXT NOT NULL,
      context_snapshot_id TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The snapshot this rejection was decided against. Refusing an absent one keeps every stored
      -- row re-derivable, the same guarantee differential_observations' FK gives P13.
      CONSTRAINT candidate_dataset_entries_snapshot_resolvable
        FOREIGN KEY (context_encoding_version, context_snapshot_id)
        REFERENCES decision_snapshots (encoding_version, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS candidate_dataset_entries_instrument_idx
      ON candidate_dataset_entries (instrument_symbol, decision_at DESC);

    CREATE OR REPLACE FUNCTION reject_candidate_dataset_entry_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION
        'candidate_dataset_entries is append-only: % on a stored entry is refused. A row records which '
        'side was rejected and why at one decision instant; editing it rewrites that evidence. Record a '
        'new entry instead.',
        TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS candidate_dataset_entries_reject_mutation ON candidate_dataset_entries;
    CREATE TRIGGER candidate_dataset_entries_reject_mutation
      BEFORE UPDATE OR DELETE ON candidate_dataset_entries
      FOR EACH ROW EXECUTE FUNCTION reject_candidate_dataset_entry_mutation();

    COMMENT ON TABLE candidate_dataset_entries IS
      'P6b Candidate Dataset: which thesis side was rejected, and why, at one decision instant. '
      'Append-only, content-addressed by entry_id. See migration 106.';
  `,
};
