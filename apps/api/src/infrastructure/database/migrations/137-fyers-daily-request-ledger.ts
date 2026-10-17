import type { Migration } from "../migration-runner.js";

export const fyersDailyRequestLedgerMigration: Migration = {
  id: "137-fyers-daily-request-ledger",
  sql: `
    CREATE TABLE IF NOT EXISTS fyers_daily_request_ledger (
      date_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_key, endpoint)
    );

    CREATE INDEX IF NOT EXISTS fyers_daily_request_ledger_date_idx
      ON fyers_daily_request_ledger (date_key);
  `,
};
