import type { Migration } from "../migration-runner.js";

/**
 * Per-account cap on trades opened in one IST trading day, plus the index the count needs.
 *
 * The column is nullable and left null, so applying this changes no behaviour: every existing
 * account stays uncapped until a cap is set deliberately. "Not configured" and "configured as zero"
 * must not read the same, and zero is a real setting that blocks every open, so a NOT NULL DEFAULT 0
 * would have silently halted trading on deploy.
 *
 * The index is not optional. Neither existing index can serve this count: `paper_trades_open_idx` is
 * `(account_id, opened_at DESC) WHERE status = 'OPEN'` and a daily cap counts closed trades too --
 * a scalp opened and closed in two minutes has consumed capacity -- while
 * `paper_trades_history_idx` is keyed on `closed_at`. The gate runs inside the transaction that
 * opens every trade, so an unindexed count would put a sequential scan on the hot path.
 */
export const paperAccountDailyTradeCapMigration: Migration = {
  id: "066-paper-account-daily-trade-cap",
  sql: `
    ALTER TABLE paper_accounts
      ADD COLUMN IF NOT EXISTS daily_trade_cap INTEGER;

    ALTER TABLE paper_accounts
      DROP CONSTRAINT IF EXISTS paper_accounts_daily_trade_cap_non_negative;
    ALTER TABLE paper_accounts
      ADD CONSTRAINT paper_accounts_daily_trade_cap_non_negative
      CHECK (daily_trade_cap IS NULL OR daily_trade_cap >= 0);

    CREATE INDEX IF NOT EXISTS paper_trades_account_opened_idx
      ON paper_trades (account_id, opened_at);
  `,
};
