import type { Migration } from "../migration-runner.js";

/**
 * Provisions the least-privilege capability role the physical-severance guarantee depends on.
 *
 * V1.3.1 claims the research process can write only the `research_scalp` schema and can never touch
 * production/paper/broker state. Until now that role lived only in `infra/postgres/scalp-research-role.sql`
 * as a manual "run this yourself" step that nothing executed — so operationally the guarantee did not
 * exist: severance rested on append-only triggers plus a username string-compare, neither of which is an
 * authorization boundary. Running it here, through the migration path the API executes on every deploy,
 * makes the privilege model real and idempotent.
 *
 * Scope note: this creates the NOLOGIN capability role `scalp_research_writer` and its grants only. The
 * LOGIN role the research process authenticates as (POSTGRES_RESEARCH_USER, default
 * `ai_quant_scalp_research`) carries a deployment secret and so cannot live in a static migration — the
 * deployment must still create it and grant membership, e.g.:
 *
 *   CREATE ROLE ai_quant_scalp_research LOGIN PASSWORD '<secret>';
 *   GRANT scalp_research_writer TO ai_quant_scalp_research;
 *
 * The privilege probes in scalp-research-isolation.test.ts verify the effective result against a running
 * DB (positive on research_scalp, negative on paper_trades), so a half-provisioned deployment is caught.
 *
 * Mirrors infra/postgres/scalp-research-role.sql, which is now reference-only. CREATE ROLE, GRANT, and
 * REVOKE are transactional in PostgreSQL, so this runs safely inside the migration runner's transaction.
 */
export const scalpResearchLeastPrivilegeRoleMigration: Migration = {
  id: "076-scalp-research-least-privilege-role",
  sql: `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scalp_research_writer') THEN
        CREATE ROLE scalp_research_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
      END IF;
    END;
    $$;

    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO scalp_research_writer', current_database());
    END;
    $$;

    GRANT USAGE ON SCHEMA public, research_scalp TO scalp_research_writer;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO scalp_research_writer;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA research_scalp TO scalp_research_writer;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA research_scalp TO scalp_research_writer;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON ALL TABLES IN SCHEMA public, research_scalp FROM scalp_research_writer;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT ON TABLES TO scalp_research_writer;
    ALTER DEFAULT PRIVILEGES IN SCHEMA research_scalp
      GRANT SELECT, INSERT ON TABLES TO scalp_research_writer;
    ALTER DEFAULT PRIVILEGES IN SCHEMA research_scalp
      GRANT USAGE, SELECT ON SEQUENCES TO scalp_research_writer;
  `,
};
