import type { Migration } from "../migration-runner.js";

export const paperTradePartialExitsMigration: Migration = {
  id: "064-paper-trade-partial-exits",
  sql: `
    CREATE TABLE IF NOT EXISTS paper_trade_partial_exits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paper_trade_id UUID NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
      exit_price NUMERIC(20, 6) NOT NULL,
      quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
      exit_reason TEXT NOT NULL CHECK (length(trim(exit_reason)) > 0),
      exit_fees NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (exit_fees >= 0),
      realized_pnl NUMERIC(20, 6) NOT NULL,
      exited_at TIMESTAMPTZ NOT NULL,
      idempotency_key TEXT UNIQUE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS paper_trade_partial_exits_trade_idx
      ON paper_trade_partial_exits (paper_trade_id, exited_at ASC);

    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS remaining_quantity NUMERIC(20, 4);

    -- Status-aware backfill: open/pending trades get full quantity, closed/cancelled get 0
    UPDATE paper_trades
    SET remaining_quantity =
      CASE
        WHEN status = 'OPEN' OR status = 'PENDING' THEN quantity
        ELSE 0
      END
    WHERE remaining_quantity IS NULL;

    ALTER TABLE paper_trades ALTER COLUMN remaining_quantity SET NOT NULL;

    -- Expand paper_trades exit_reason to support partial/multi-target exit reasons
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_exit_reason_check
      CHECK (exit_reason IN (
        'STOP_LOSS',
        'TARGET',
        'MANUAL',
        'CANCELLED',
        'EXPIRED',
        'TRAP_DETECTED',
        'T1_TARGET',
        'T2_TARGET',
        'RUNNER_TRAIL',
        'MOMENTUM_STALL'
      ));
  `,
};
