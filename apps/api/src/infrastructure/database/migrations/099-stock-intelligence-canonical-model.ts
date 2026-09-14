import type { Migration } from "../migration-runner.js";

/**
 * Gate 1 of Stock Intelligence. Isolated schema so trading tables stay untouched.
 *
 * Identity remains `instruments.id` (UUID). A parallel `IND_EQUITY_*` key is not
 * introduced. PostgreSQL is the existing database; TimescaleDB is not added.
 *
 * Tables are append-only. Restatements and roster corrections are new rows. The
 * M01 seed does not live here — `SeedStockIntelligenceUniverse` writes the current
 * Nifty 50 / Next 50 snapshot and stamps it as `current_roster_snapshot`, so a
 * migrate-only database cannot pretend it has a 2015 survivorship-safe universe.
 */
export const stockIntelligenceCanonicalModelMigration: Migration = {
  id: "099-stock-intelligence-canonical-model",
  sql: `
    CREATE SCHEMA IF NOT EXISTS stock_intelligence;

    CREATE OR REPLACE FUNCTION stock_intelligence.reject_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'stock_intelligence records are append-only';
    END;
    $$;

    CREATE TABLE stock_intelligence.aliases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (alias)
    );
    CREATE INDEX stock_intelligence_aliases_instrument_idx
      ON stock_intelligence.aliases (instrument_id);

    CREATE TABLE stock_intelligence.existence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      listed_from DATE,
      listed_to DATE,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (listed_to IS NULL OR listed_from IS NULL OR listed_to >= listed_from)
    );
    CREATE INDEX stock_intelligence_existence_asof_idx
      ON stock_intelligence.existence (instrument_id, available_at DESC);

    CREATE TABLE stock_intelligence.universe_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      universe TEXT NOT NULL CHECK (universe IN ('NIFTY50', 'NIFTYNXT50', 'INDEX_CONTEXT')),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('current_roster_snapshot', 'historical_archive', 'manual_correction')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (effective_to IS NULL OR effective_to > effective_from),
      CHECK (available_at <= effective_from OR provenance <> 'historical_archive')
    );
    CREATE INDEX stock_intelligence_memberships_asof_idx
      ON stock_intelligence.universe_memberships (instrument_id, universe, effective_from DESC);

    CREATE TABLE stock_intelligence.sector_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      sector TEXT NOT NULL CHECK (length(trim(sector)) > 0),
      effective_from DATE NOT NULL,
      effective_to DATE,
      available_at TIMESTAMPTZ NOT NULL,
      sector_stable BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );
    CREATE INDEX stock_intelligence_sector_asof_idx
      ON stock_intelligence.sector_history (instrument_id, effective_from DESC);

    CREATE TABLE stock_intelligence.raw_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID REFERENCES instruments(id) ON DELETE RESTRICT,
      source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      data_schema_version TEXT NOT NULL CHECK (length(trim(data_schema_version)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_raw_asof_idx
      ON stock_intelligence.raw_records (instrument_id, available_at DESC);

    CREATE TABLE stock_intelligence.canonical_facts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      fact_name TEXT NOT NULL CHECK (length(trim(fact_name)) > 0),
      fact_value JSONB NOT NULL CHECK (jsonb_typeof(fact_value) = 'object'),
      source_raw_id UUID REFERENCES stock_intelligence.raw_records(id) ON DELETE RESTRICT,
      source_document TEXT,
      source_page INTEGER CHECK (source_page IS NULL OR source_page > 0),
      extraction_model TEXT,
      extraction_version TEXT,
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      data_schema_version TEXT NOT NULL CHECK (length(trim(data_schema_version)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_facts_asof_idx
      ON stock_intelligence.canonical_facts (instrument_id, fact_name, available_at DESC);

    CREATE TABLE stock_intelligence.derived_features (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      feature_name TEXT NOT NULL CHECK (length(trim(feature_name)) > 0),
      feature_value JSONB NOT NULL CHECK (jsonb_typeof(feature_value) = 'object'),
      derived_from_fact_ids UUID[] NOT NULL DEFAULT '{}',
      feature_version TEXT NOT NULL CHECK (length(trim(feature_version)) > 0),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_features_asof_idx
      ON stock_intelligence.derived_features (instrument_id, feature_name, available_at DESC);

    CREATE TABLE stock_intelligence.signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      signal_name TEXT NOT NULL CHECK (length(trim(signal_name)) > 0),
      signal_value JSONB NOT NULL CHECK (jsonb_typeof(signal_value) = 'object'),
      strength NUMERIC,
      derived_from JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_from) = 'object'),
      source_facts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_facts) = 'object'),
      feature_version TEXT NOT NULL CHECK (length(trim(feature_version)) > 0),
      engine_version TEXT NOT NULL CHECK (length(trim(engine_version)) > 0),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_signals_asof_idx
      ON stock_intelligence.signals (instrument_id, signal_name, available_at DESC);

    CREATE TABLE stock_intelligence.fundamental_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      field TEXT NOT NULL CHECK (length(trim(field)) > 0),
      value NUMERIC NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('REPORTED_ACTUAL', 'ANALYST_ESTIMATE')),
      report_date DATE NOT NULL,
      period_end DATE NOT NULL,
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      data_schema_version TEXT NOT NULL CHECK (length(trim(data_schema_version)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_fundamentals_asof_idx
      ON stock_intelligence.fundamental_snapshots (instrument_id, field, available_at DESC);

    CREATE TABLE stock_intelligence.corporate_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      action_type TEXT NOT NULL CHECK (action_type IN ('SPLIT', 'BONUS', 'RIGHTS', 'DIVIDEND', 'BUYBACK', 'MERGER', 'DELISTING')),
      ex_date DATE NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_actions_asof_idx
      ON stock_intelligence.corporate_actions (instrument_id, ex_date DESC);

    CREATE TABLE stock_intelligence.replay_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETE', 'FAILED')),
      completed_pairs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_pairs) = 'array'),
      remaining_pairs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(remaining_pairs) = 'array'),
      last_checkpoint TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    COMMENT ON SCHEMA stock_intelligence IS
      'M01 four-layer canonical model. Append-only. instrument_id is instruments.id. Roster seed is a current snapshot, not a 2015 survivorship archive.';

    DO $$
    DECLARE
      tbl TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'aliases', 'existence', 'universe_memberships', 'sector_history',
        'raw_records', 'canonical_facts', 'derived_features', 'signals',
        'fundamental_snapshots', 'corporate_actions'
      ]
      LOOP
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON stock_intelligence.%I FOR EACH ROW EXECUTE FUNCTION stock_intelligence.reject_mutation()',
          'reject_mutation_' || tbl,
          tbl
        );
      END LOOP;
    END
    $$;
  `,
};
