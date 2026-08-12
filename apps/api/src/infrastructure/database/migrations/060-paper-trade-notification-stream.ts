import type { Migration } from "../migration-runner.js";

/** Keeps the global OPENED-event tail used by the dashboard SSE stream index-only and cheap. */
export const paperTradeNotificationStreamMigration: Migration = {
  id: "060-paper-trade-notification-stream",
  sql: `
    CREATE INDEX IF NOT EXISTS paper_trade_events_opened_tail_idx
    ON paper_trade_events (occurred_at DESC, id DESC)
    WHERE event_type = 'OPENED';
  `,
};
