import type { Migration } from "../migration-runner.js";

/**
 * The append-only decision ledger (I13, I15), with `expectedVersion` and uniqueness enforced by the
 * database rather than by application code (I23, I24).
 *
 * ## The UNIQUE constraint *is* the optimistic concurrency mechanism
 *
 * An append writes at `expectedVersion + 1`. `decision_ledger_aggregate_version_key` then decides:
 * two concurrent writers at the same expected version target the same number, and exactly one insert
 * survives. Atomic by construction, with no read-then-write window in which an update can be lost.
 *
 * Deliberately *not* the `FOR UPDATE` pattern the paper-trade capacity gate uses. That gate must count
 * rows before deciding, so it needs a lock. Here there is nothing to count -- the version being free is
 * the condition -- so the insert is the check. Reaching for the familiar lock would add contention and
 * buy no guarantee.
 *
 * ## Constraints are named explicitly
 *
 * Not stylistic. An earlier finding in this repository was a false-positive review of a migration that
 * inferred which constraint a bare-name DROP would hit from the SQL text and got it wrong -- the real
 * name was auto-generated with a `_check2` suffix. The append path distinguishes a version conflict
 * from a duplicate event id *by constraint name*, so those names are load-bearing and are written here
 * rather than left to Postgres.
 *
 * ## The foreign key to `decision_snapshots` is the I20 guarantee
 *
 * I20 requires every paper trade to be fully replayable, and replay needs the sealed context an event
 * was decided against. Without this key, an event could reference a snapshot that was never stored, and
 * the decision would be unreplayable -- discovered at replay, when the session is long gone.
 *
 * With it, that state cannot exist: the context must be sealed before any event referencing it can be
 * written. The key is on `(encoding_version, snapshot_id)` because that is the snapshot store's key,
 * and for the reason it is: a different canonical encoding is a different address space, not a format
 * detail.
 *
 * ## `sequence` and `aggregate_version` are different numbers
 *
 * `aggregate_version` is per decision, dense from 1, and is what concurrency compares against.
 * `sequence` is the global append order, assigned by the database, and answers "what happened next in
 * the system" -- which per-aggregate versions cannot, since two decisions both at version 3 say nothing
 * about which was written first. Brain V2.2 §3 lists both without distinguishing them; the distinction
 * is recorded in `decision-ledger.ts`.
 *
 * ## Append-only by trigger
 *
 * Following migrations 074 and 086. An UPDATE would break the hash chain silently for anyone not
 * re-verifying it, and a DELETE would make a decision unreplayable. The chain makes tampering evident;
 * the trigger makes the easy path unavailable.
 */
export const decisionLedgerMigration: Migration = {
  id: "087-decision-ledger",
  sql: `
    CREATE OR REPLACE FUNCTION reject_decision_ledger_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'decision_ledger is append-only: history is never updated in place (I15)';
    END;
    $$;

    CREATE TABLE IF NOT EXISTS decision_ledger (
      -- Global append order across every decision, assigned here so no producer can invent it.
      sequence BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0),
      decision_id TEXT NOT NULL CHECK (length(trim(decision_id)) > 0),
      aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) > 0),
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
      occurred_at TIMESTAMPTZ NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'STAGE_COMPLETED', 'DECISION_REJECTED', 'DECISION_DEFERRED', 'DECISION_CLOSED_NO_ACTION'
      )),
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      state_from TEXT NOT NULL CHECK (length(trim(state_from)) > 0),
      state_to TEXT NOT NULL CHECK (length(trim(state_to)) > 0),
      -- The sealed context, and the encoding that addresses it.
      context_encoding_version TEXT NOT NULL,
      context_snapshot_id CHAR(64) NOT NULL CHECK (context_snapshot_id ~ '^[0-9a-f]{64}$'),
      policy_versions JSONB NOT NULL CHECK (jsonb_typeof(policy_versions) = 'object'),
      correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
      causation_id TEXT,
      payload_snapshot_id CHAR(64) CHECK (payload_snapshot_id IS NULL OR payload_snapshot_id ~ '^[0-9a-f]{64}$'),
      -- Null only for an aggregate's opening event; enforced in the domain, where the head is known.
      previous_event_hash CHAR(64) CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[0-9a-f]{64}$'),
      event_hash CHAR(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
      producer_service TEXT NOT NULL CHECK (length(trim(producer_service)) > 0),
      producer_version TEXT NOT NULL CHECK (length(trim(producer_version)) > 0),
      producer_instance_id TEXT NOT NULL CHECK (length(trim(producer_instance_id)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- I24. Named, because the append path tells these two apart by name.
      CONSTRAINT decision_ledger_event_id_key UNIQUE (event_id),
      -- I23. This is the atomicity mechanism, not merely an integrity check.
      CONSTRAINT decision_ledger_aggregate_version_key UNIQUE (aggregate_id, aggregate_version),
      -- I20. An event whose context was never sealed is an unreplayable decision.
      CONSTRAINT decision_ledger_context_resolvable FOREIGN KEY (context_encoding_version, context_snapshot_id)
        REFERENCES decision_snapshots (encoding_version, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS decision_ledger_aggregate_idx
      ON decision_ledger (aggregate_id, aggregate_version);

    COMMENT ON TABLE decision_ledger IS
      'Append-only Brain V2.2 decision ledger. expectedVersion is enforced by '
      'decision_ledger_aggregate_version_key rather than by a lock: an append writes at '
      'expectedVersion + 1 and the constraint picks the single winner. Never UPDATE or DELETE.';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'decision_ledger_reject_mutation'
          AND tgrelid = 'decision_ledger'::regclass
      ) THEN
        CREATE TRIGGER decision_ledger_reject_mutation
        BEFORE UPDATE OR DELETE ON decision_ledger
        FOR EACH ROW EXECUTE FUNCTION reject_decision_ledger_mutation();
      END IF;
    END;
    $$;
  `,
};
