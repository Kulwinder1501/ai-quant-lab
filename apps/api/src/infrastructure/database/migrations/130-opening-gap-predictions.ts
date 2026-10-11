import type { Migration } from "../migration-runner.js";

// One row per (instrument, session), written before the 09:15 IST open and settled shortly
// after it -- mirrors the attempt/terminal-snapshot split used elsewhere in this codebase
// (e.g. `auxiliary_model_predictions`): a prediction is written write-only at first, then
// graded in place once the real open is known, rather than living in two tables.
//
// `UNIQUE (instrument_symbol, session_date)` makes the morning predictor idempotent against
// a re-run on the same session, and the `ON CONFLICT ... WHERE settled_at IS NULL` guard the
// repository uses alongside it means a re-run can never clobber an already-graded row.
export const openingGapPredictionsMigration: Migration = {
  id: "130-opening-gap-predictions",
  sql: `
    CREATE TABLE IF NOT EXISTS opening_gap_predictions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_symbol TEXT NOT NULL CHECK (instrument_symbol IN ('NIFTY50', 'BANKNIFTY')),
      session_date DATE NOT NULL,
      predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      driver_symbol TEXT NOT NULL,
      driver_change_pct NUMERIC NOT NULL,
      threshold_pct NUMERIC NOT NULL,
      expectation TEXT NOT NULL CHECK (expectation IN ('GAP_UP', 'GAP_DOWN', 'FLAT')),
      -- Readings not used by the classification rule (Nikkei/Hang Seng at prediction time),
      -- kept so a later decision to fold them into the rule can be evaluated against history
      -- instead of only future data.
      supplementary_cues JSONB NOT NULL DEFAULT '{}'::jsonb,
      previous_close NUMERIC,
      actual_open NUMERIC,
      actual_gap_pct NUMERIC,
      actual_expectation TEXT CHECK (actual_expectation IN ('GAP_UP', 'GAP_DOWN', 'FLAT')),
      was_correct BOOLEAN,
      settled_at TIMESTAMPTZ,
      unsettleable_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (instrument_symbol, session_date)
    );

    -- What the settlement sweep selects: matured, ungraded, not already given up on.
    CREATE INDEX IF NOT EXISTS opening_gap_predictions_pending_settlement_idx
      ON opening_gap_predictions (session_date)
      WHERE settled_at IS NULL AND unsettleable_reason IS NULL;

    -- What an accuracy scoreboard reads.
    CREATE INDEX IF NOT EXISTS opening_gap_predictions_settled_idx
      ON opening_gap_predictions (instrument_symbol, session_date DESC)
      WHERE settled_at IS NOT NULL;
  `,
};
