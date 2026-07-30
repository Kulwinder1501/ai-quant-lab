import type { Migration } from "../migration-runner.js";

export const pendingPaperTradesMigration: Migration = {
  id: "009-pending-paper-trades",
  sql: `
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_status_check;
    ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_status_check CHECK (status IN ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED'));

    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_check1;
    ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_check1 CHECK (
      (status IN ('OPEN', 'PENDING') AND closed_at IS NULL AND exit_price IS NULL AND realized_pnl IS NULL)
      OR (status = 'CLOSED' AND closed_at IS NOT NULL AND exit_price IS NOT NULL AND realized_pnl IS NOT NULL)
      OR status = 'CANCELLED'
    );

    ALTER TABLE paper_trade_events DROP CONSTRAINT IF EXISTS paper_trade_events_event_type_check;
    ALTER TABLE paper_trade_events ADD CONSTRAINT paper_trade_events_event_type_check CHECK (event_type IN ('PENDING_PLACED', 'OPENED', 'STOP_LOSS_HIT', 'TARGET_HIT', 'MANUALLY_CLOSED', 'CANCELLED'));
  `,
};
