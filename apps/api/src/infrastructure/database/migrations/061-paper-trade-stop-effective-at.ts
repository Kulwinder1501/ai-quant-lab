import type { Migration } from "../migration-runner.js";

/**
 * Records when the current stop became authoritative for dense option-tick evaluation.
 * Existing OPEN trades start at migration time because their earlier stop history cannot be
 * reconstructed safely; fabricating a retrospective exit would be worse than starting fresh.
 */
export const paperTradeStopEffectiveAtMigration: Migration = {
  id: "061-paper-trade-stop-effective-at",
  sql: `
    ALTER TABLE paper_trades
      ADD COLUMN IF NOT EXISTS stop_loss_effective_at TIMESTAMPTZ;

    UPDATE paper_trades
    SET stop_loss_effective_at = CASE
      WHEN status = 'OPEN' THEN CURRENT_TIMESTAMP
      ELSE opened_at
    END
    WHERE stop_loss_effective_at IS NULL;

    ALTER TABLE paper_trades
      ALTER COLUMN stop_loss_effective_at SET NOT NULL;
  `,
};
