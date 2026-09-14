import type { Migration } from "../migration-runner.js";

/** One paper structure at most for one immutable auxiliary prediction. */
export const volatilityStraddleRunsMigration: Migration = {
  id: "059-volatility-straddle-runs",
  sql: `
    CREATE TABLE IF NOT EXISTS volatility_straddle_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      prediction_id UUID NOT NULL UNIQUE REFERENCES auxiliary_model_predictions(id) ON DELETE RESTRICT,
      account_id UUID REFERENCES paper_accounts(id) ON DELETE SET NULL,
      ce_trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL,
      pe_trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL,
      ce_paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL,
      pe_paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('CLAIMED', 'OPENED', 'REFUSED', 'FAILED')),
      reason TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      CHECK ((status = 'CLAIMED' AND completed_at IS NULL) OR (status <> 'CLAIMED' AND completed_at IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS volatility_straddle_runs_status_time_idx
    ON volatility_straddle_runs (status, claimed_at DESC);
  `,
};
