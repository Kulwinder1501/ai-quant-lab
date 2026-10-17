import type { Migration } from "../migration-runner.js";

// Dedicated self-contained schema for equity research (Slice 0).
//
// Hard rule: every table lives in the equity_research schema, with NO foreign key
// to or from any other schema. This ensures complete isolation from trading modules
// and allows clean drop/archive if ever required.
export const equityResearchSchemaMigration: Migration = {
  id: "138-equity-research-schema",
  sql: `
    CREATE SCHEMA IF NOT EXISTS equity_research;

    -- 1. Watchlist stocks (single user, NSE/BSE stocks)
    CREATE TABLE IF NOT EXISTS equity_research.watchlist_stock (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exchange TEXT NOT NULL CHECK (exchange IN ('NSE', 'BSE')),
      symbol TEXT NOT NULL,
      yahoo_symbol TEXT NOT NULL,
      display_name TEXT,
      currency TEXT NOT NULL DEFAULT 'INR',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      note TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      removed_at TIMESTAMPTZ,
      CONSTRAINT watchlist_stock_exchange_symbol_key UNIQUE (exchange, symbol)
    );

    CREATE INDEX IF NOT EXISTS watchlist_stock_active_idx
      ON equity_research.watchlist_stock (active, exchange, symbol);

    -- 2. Raw record landing (land first, parse later; immutable)
    CREATE TABLE IF NOT EXISTS equity_research.raw_record (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      http_status INTEGER NOT NULL,
      body_sha256 TEXT NOT NULL,
      body JSONB NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('OK', 'EMPTY', 'RATE_LIMITED', 'ERROR')),
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX IF NOT EXISTS raw_record_symbol_endpoint_idx
      ON equity_research.raw_record (symbol, endpoint, requested_at DESC);

    -- 3. Daily price bars (raw close, NOT adjclose)
    CREATE TABLE IF NOT EXISTS equity_research.price_bar (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      bar_date DATE NOT NULL,
      open NUMERIC(20, 4) NOT NULL,
      high NUMERIC(20, 4) NOT NULL,
      low NUMERIC(20, 4) NOT NULL,
      close NUMERIC(20, 4) NOT NULL,
      volume BIGINT NOT NULL,
      source TEXT NOT NULL DEFAULT 'YAHOO',
      raw_record_id UUID REFERENCES equity_research.raw_record(id) ON DELETE SET NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT price_bar_stock_bar_date_key UNIQUE (stock_id, bar_date)
    );

    CREATE INDEX IF NOT EXISTS price_bar_stock_date_desc_idx
      ON equity_research.price_bar (stock_id, bar_date DESC);

    -- 4. Revisions table for restated price bars
    CREATE TABLE IF NOT EXISTS equity_research.price_bar_revision (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      bar_date DATE NOT NULL,
      previous_values JSONB NOT NULL,
      new_values JSONB NOT NULL,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_record_id UUID REFERENCES equity_research.raw_record(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS price_bar_revision_stock_date_idx
      ON equity_research.price_bar_revision (stock_id, bar_date, seen_at DESC);

    -- 5. Corporate actions (dividends and splits)
    CREATE TABLE IF NOT EXISTS equity_research.corporate_action (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      ex_date DATE NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('DIVIDEND', 'SPLIT')),
      value NUMERIC(20, 4) NOT NULL,
      source TEXT NOT NULL DEFAULT 'YAHOO',
      raw_record_id UUID REFERENCES equity_research.raw_record(id) ON DELETE SET NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT corporate_action_stock_ex_date_kind_key UNIQUE (stock_id, ex_date, kind)
    );

    CREATE INDEX IF NOT EXISTS corporate_action_stock_ex_date_idx
      ON equity_research.corporate_action (stock_id, ex_date DESC);

    -- 6. Secondary facts (fundamentals from Yahoo, accumulates restatement history)
    CREATE TABLE IF NOT EXISTS equity_research.secondary_fact (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_id UUID NOT NULL REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      period_type TEXT NOT NULL CHECK (period_type IN ('ANNUAL', 'QUARTERLY')),
      period_end DATE NOT NULL,
      value NUMERIC(24, 4) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      basis TEXT NOT NULL DEFAULT 'UNKNOWN',
      raw_record_id UUID REFERENCES equity_research.raw_record(id) ON DELETE SET NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS secondary_fact_lookup_idx
      ON equity_research.secondary_fact (stock_id, item, period_type, period_end, first_seen_at DESC);

    -- 7. Quote cache (on-demand quotes with source latency tracking)
    CREATE TABLE IF NOT EXISTS equity_research.quote_cache (
      stock_id UUID PRIMARY KEY REFERENCES equity_research.watchlist_stock(id) ON DELETE CASCADE,
      last_price NUMERIC(20, 4) NOT NULL,
      market_time TIMESTAMPTZ NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      label TEXT NOT NULL,
      latency_seconds NUMERIC(10, 2)
    );

    -- 8. Source health tracking
    CREATE TABLE IF NOT EXISTS equity_research.source_health (
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      last_success_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'OK',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      calls_today INTEGER NOT NULL DEFAULT 0,
      budget_today INTEGER NOT NULL DEFAULT 300,
      date_key TEXT NOT NULL,
      PRIMARY KEY (source, endpoint)
    );

    -- 9. Source call log (audit trail for rate discipline and reliability)
    CREATE TABLE IF NOT EXISTS equity_research.source_call_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS source_call_log_time_idx
      ON equity_research.source_call_log (time DESC);
  `,
};
