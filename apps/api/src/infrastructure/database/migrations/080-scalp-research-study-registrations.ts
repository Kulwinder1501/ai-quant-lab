import type { Migration } from "../migration-runner.js";

/**
 * Pre-registration for the exit-geometry program: what each study was allowed to search, frozen before
 * it ran.
 *
 * ## Why this is a table and not a document
 *
 * The deflated Sharpe ratio and probability-of-backtest-overfitting corrections both take the number of
 * configurations examined as an input. Reconstructed from memory after the fact that number is always
 * too small — nobody remembers the grids that were abandoned — and the correction becomes decorative.
 * A stored registration with a content hash makes the search space a fact rather than a recollection.
 *
 * The append-only trigger is what gives the hash its meaning. `study_key` is unique and the row cannot
 * be updated, so widening a grid is physically impossible: the registrar finds the existing row, sees a
 * different definition hash, and refuses. The only way forward is a new key with an explicit version,
 * which is exactly the accounting the correction needs.
 *
 * ## The trial ledger is deliberately not here
 *
 * One row per *executed* configuration — `executed_at`, dataset cutoff, session range, code version,
 * result — is required before any geometry cell is searched, and it lands with the study runner rather
 * than ahead of it, so its columns are set by a real writer instead of guessed. Nothing can execute
 * unrecorded as a result: the runner and its table arrive in the same change. Registration has to come
 * first because it is what the first execution is checked against; the ledger does not.
 *
 * Grants are inherited. Migration 076 set `ALTER DEFAULT PRIVILEGES IN SCHEMA research_scalp GRANT
 * SELECT, INSERT ON TABLES TO scalp_research_writer`, and this table is created by the same role, so
 * the research process can register and read a study and can never rewrite one.
 */
export const scalpResearchStudyRegistrationsMigration: Migration = {
  id: "080-scalp-research-study-registrations",
  sql: `
    CREATE TABLE IF NOT EXISTS research_scalp.study_registrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Unique, so a second registration of the same key is a conflict the registrar has to resolve
      -- against the stored hash rather than a silent second row.
      study_key TEXT NOT NULL UNIQUE CHECK (study_key ~ '^[A-Z0-9_]+_V[0-9]+$'),
      study_definition_hash CHAR(64) NOT NULL CHECK (study_definition_hash ~ '^[0-9a-f]{64}$'),
      question TEXT NOT NULL CHECK (length(trim(question)) > 0),
      -- PRE_SPECIFIED or DATA_INSPECTED. Stored as a column rather than buried in the specification
      -- because the multiplicity correction has to be able to separate the two without parsing JSON,
      -- and a post-hoc family counted as pre-specified flatters the result.
      provenance TEXT NOT NULL CHECK (provenance IN ('PRE_SPECIFIED', 'DATA_INSPECTED')),
      provenance_note TEXT NOT NULL CHECK (length(trim(provenance_note)) > 0),
      specification JSONB NOT NULL CHECK (jsonb_typeof(specification) = 'object'),
      registry_encoding_version TEXT NOT NULL CHECK (length(trim(registry_encoding_version)) > 0),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'study_registrations_reject_mutation'
          AND tgrelid = 'research_scalp.study_registrations'::regclass
      ) THEN
        CREATE TRIGGER study_registrations_reject_mutation
          BEFORE UPDATE OR DELETE ON research_scalp.study_registrations
          FOR EACH ROW EXECUTE FUNCTION research_scalp.reject_mutation();
      END IF;
    END;
    $$;

    COMMENT ON TABLE research_scalp.study_registrations IS
      'Pre-registered study definitions. Append-only: a changed specification is a new versioned key.';
  `,
};
