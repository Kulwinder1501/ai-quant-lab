-- REFERENCE COPY. This capability role is now provisioned automatically by migration
-- 076-scalp-research-least-privilege-role.ts, which runs on every deploy — you do NOT need to run
-- this file by hand. It is kept only to document the privilege model in one place.
--
-- Still a deployment step (a secret cannot live in a static migration): create the LOGIN role the
-- research process authenticates as and grant it membership, e.g.
--   CREATE ROLE ai_quant_scalp_research LOGIN PASSWORD '<secret>';
--   GRANT scalp_research_writer TO ai_quant_scalp_research;
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
