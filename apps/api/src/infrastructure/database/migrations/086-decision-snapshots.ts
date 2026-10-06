import type { Migration } from "../migration-runner.js";

/**
 * The content-addressed immutable store Brain V2.2's `SnapshotRef` resolves against (I21).
 *
 * ## Why a store at all, rather than a query
 *
 * I21 requires a `SnapshotRef` to resolve to immutable data, and two cheaper designs fail against
 * mechanisms this system actually runs:
 *
 * - A **range predicate** ("every bar through T") cannot work, because index candle gaps self-heal
 *   nightly at 16:18 and the heal is an *append into a historical range*. Re-resolving after a repair
 *   returns a different row set: same reference, different data, no error raised.
 *   `pattern_observations_v2_frozen_tape` (migration 085) exists because that class of silent change
 *   had already produced 25 bad rows once.
 * - A **manifest of row ids** survives appends but not mutation, and candle rows are mutated -- each is
 *   written once mid-bar and updated once after the bar seals. Resolution could then *detect* that
 *   content changed but not *return* what was sealed. I21 says resolve, not detect.
 *
 * So the bytes are copied on seal. Deduplication makes that affordable: the address is derived from
 * the content, so hundreds of decisions a session over heavily overlapping bar sets collapse to one
 * row per distinct payload.
 *
 * ## The primary key is (encoding_version, snapshot_id), not snapshot_id alone
 *
 * A different canonical encoding is a different address space, not a format detail -- the same
 * doctrine that keeps `sha256CanonicalJson` and `sha256CanonicalBytes` as separate functions after D1.
 * Keying on the digest alone would let a future encoder's digest collide with this one's and silently
 * resolve the wrong payload. Keying on both means an encoding change adds rows rather than
 * reinterpreting existing ones.
 *
 * ## Append-only, enforced by trigger
 *
 * Following migration 074's pattern rather than trusting the write path. Content addressing makes an
 * UPDATE meaningless by construction: if the bytes changed, the address changed, so a row whose bytes
 * were edited is a row lying about its own identity. Every reference to it -- including ones already
 * written into decision records -- would then resolve to something that was never sealed.
 *
 * A DELETE is refused for the same reason replay needs it: a sealed decision that cannot resolve its
 * context is unreplayable, and I20 requires every paper trade to be fully replayable. Losing a
 * snapshot is not a tidy-up, it is the destruction of a decision's only record of what it saw.
 *
 * ## byte_length is stored and checked
 *
 * Not redundant. It makes a truncated write detectable at the row rather than at the next resolution:
 * a `CHECK` that the recorded length equals the actual length turns silent truncation into a refused
 * insert. The same reason the golden pin for the canonical encoder asserts length as well as digest --
 * a failure then says whether the shape or only the content moved.
 *
 * Idempotent: `IF NOT EXISTS` throughout, and the trigger is created only when absent, so a re-run is
 * a no-op rather than an error. The migration ledger has drifted from the schema before when
 * hand-applied DDL was invisible to the runner, so this goes through the runner like everything else.
 */
export const decisionSnapshotsMigration: Migration = {
  id: "086-decision-snapshots",
  sql: `
    CREATE OR REPLACE FUNCTION reject_decision_snapshot_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'decision_snapshots is content-addressed and append-only: a change to the bytes is a change to the address';
    END;
    $$;

    CREATE TABLE IF NOT EXISTS decision_snapshots (
      -- The encoding comes first in the key because it scopes the address space.
      encoding_version TEXT NOT NULL CHECK (length(trim(encoding_version)) > 0),
      snapshot_id CHAR(64) NOT NULL CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      -- The canonical bytes, verbatim. The unit of the I21 guarantee.
      bytes TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      first_sealed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (encoding_version, snapshot_id),
      -- Turns a truncated write into a refused insert rather than a surprise at resolution.
      CONSTRAINT decision_snapshots_length_matches CHECK (byte_length = length(bytes))
    );

    COMMENT ON TABLE decision_snapshots IS
      'Content-addressed immutable snapshot store for Brain V2.2 (I21). The address is derived from '
      'the bytes, so an UPDATE is a contradiction and is refused by trigger. Never DELETE: a decision '
      'that cannot resolve its sealed context is unreplayable (I20).';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'decision_snapshots_reject_mutation'
          AND tgrelid = 'decision_snapshots'::regclass
      ) THEN
        CREATE TRIGGER decision_snapshots_reject_mutation
        BEFORE UPDATE OR DELETE ON decision_snapshots
        FOR EACH ROW EXECUTE FUNCTION reject_decision_snapshot_mutation();
      END IF;
    END;
    $$;
  `,
};
