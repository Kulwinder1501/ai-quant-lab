import type { Migration } from "../migration-runner.js";

// Dedicated tables for Equity Alerts and Event Flags (Step 2).
//
// Hard rule: every table lives inside the equity_research schema,
// with NO foreign key to or from any other schema (Gate E13).
// Immutable rows: alerts and events cannot be modified in place.
export const equityAlertsAndEventsMigration: Migration = {
  id: "140-equity-alerts-and-events",
  sql: `
    -- 1. End-of-Day Alerts (Gate E1: idempotent, immutable payload snapshot)
    CREATE TABLE IF NOT EXISTS equity_research.alert (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      level_key TEXT,
      evaluated_date DATE NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('INFO', 'NOTICE')),
      title TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Unique index enforcing exactly one alert per (stock, kind, level, evaluated_date)
    CREATE UNIQUE INDEX IF NOT EXISTS alert_stock_kind_level_date_idx
      ON equity_research.alert (stock_id, kind, (COALESCE(level_key, '')), evaluated_date);

    CREATE INDEX IF NOT EXISTS alert_stock_date_idx
      ON equity_research.alert (stock_id, evaluated_date DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS alert_date_idx
      ON equity_research.alert (evaluated_date DESC);

    -- 2. Alert State (NEW, SEEN, DISMISSED)
    CREATE TABLE IF NOT EXISTS equity_research.alert_state (
      alert_id UUID PRIMARY KEY REFERENCES equity_research.alert(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'SEEN', 'DISMISSED')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS alert_state_status_idx
      ON equity_research.alert_state (status, updated_at DESC);

    -- 3. Event Flags (Detected corporate/move events + owner-entered cited events)
    CREATE TABLE IF NOT EXISTS equity_research.event_flag (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('DETECTED', 'MANUAL')),
      event_date DATE NOT NULL,
      headline TEXT NOT NULL,
      source_url TEXT,
      detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      supersedes_id UUID REFERENCES equity_research.event_flag(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Gate E8: origin MANUAL strictly requires a non-empty https source_url
      CONSTRAINT event_flag_manual_https_check CHECK (
        origin != 'MANUAL' OR (source_url IS NOT NULL AND length(trim(source_url)) > 8 AND source_url ~* '^https://.+')
      )
    );

    -- Detected events are unique per (stock_id, kind, event_date, detail key) so re-runs never duplicate
    CREATE UNIQUE INDEX IF NOT EXISTS event_flag_detected_uniq_idx
      ON equity_research.event_flag (stock_id, kind, event_date, (COALESCE(detail_json->>'key', '')))
      WHERE origin = 'DETECTED';

    CREATE INDEX IF NOT EXISTS event_flag_stock_date_idx
      ON equity_research.event_flag (stock_id, event_date DESC, created_at DESC);
  `,
};
