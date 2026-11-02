import type { Migration } from "../migration-runner.js";

/**
 * The pre-open levels sheet and the study that says how its levels have behaved.
 *
 * Two new tables, nothing altered, so old code against a migrated database is unaffected and the order of recreating containers does not
 * matter.
 *
 * `daily_level_sheets` keeps every sheet that was generated for a session, numbered by version, never overwritten: a sheet is a
 * point-in-time statement of what was known before the open, and a rerun (a fixed bug, a late option-chain observation) is a new version,
 * not an edit of the old one. Readers take the highest version. The payload is the sheet as the domain code built it; the typed columns
 * are what is queried.
 *
 * `daily_level_study_results` holds the outputs of the placebo-controlled reaction study (docs/2026-11-02-daily-levels-sheet-and-
 * reaction-protocol.md). Each run is a new row; the study is descriptive and is not a gate on anything.
 */
export const dailyLevelsMigration: Migration = {
  id: "143-daily-levels",
  sql: `
    CREATE TABLE IF NOT EXISTS daily_level_sheets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      underlying_symbol TEXT NOT NULL CHECK (underlying_symbol IN ('NIFTY50', 'BANKNIFTY')),
      session_date DATE NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      reference_date DATE NOT NULL,
      reference_price NUMERIC(20, 4) NOT NULL CHECK (reference_price > 0),
      payload JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT daily_level_sheets_one_per_version UNIQUE (underlying_symbol, session_date, version),
      CONSTRAINT daily_level_sheets_reference_before_session CHECK (reference_date < session_date)
    );

    CREATE INDEX IF NOT EXISTS daily_level_sheets_latest
      ON daily_level_sheets (underlying_symbol, session_date DESC, version DESC);

    COMMENT ON TABLE daily_level_sheets IS
      'One row per generated pre-open levels sheet. A rerun is a new version; the highest version is the current sheet. Built only from data observed before the session.';

    CREATE TABLE IF NOT EXISTS daily_level_study_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      study_version TEXT NOT NULL CHECK (length(trim(study_version)) > 0),
      underlying_symbol TEXT NOT NULL CHECK (underlying_symbol IN ('NIFTY50', 'BANKNIFTY')),
      window_from DATE NOT NULL,
      window_to DATE NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload JSONB NOT NULL,
      CONSTRAINT daily_level_study_window_ordered CHECK (window_from <= window_to)
    );

    CREATE INDEX IF NOT EXISTS daily_level_study_results_latest
      ON daily_level_study_results (underlying_symbol, study_version, computed_at DESC);

    COMMENT ON TABLE daily_level_study_results IS
      'Outputs of the placebo-controlled reaction study of the daily levels. Descriptive only; not a gate.';
  `,
};
