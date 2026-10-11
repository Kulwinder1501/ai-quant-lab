import type { Migration } from "../migration-runner.js";

export const oandaBidAskCandlesMigration: Migration = {
  id: "129-oanda-bid-ask-candles",
  sql: `
    CREATE TABLE IF NOT EXISTS oanda_bid_ask_candles (
      id BIGSERIAL PRIMARY KEY,
      instrument TEXT NOT NULL,
      granularity TEXT NOT NULL,
      time TIMESTAMPTZ NOT NULL,
      
      bid_open NUMERIC NOT NULL,
      bid_high NUMERIC NOT NULL,
      bid_low NUMERIC NOT NULL,
      bid_close NUMERIC NOT NULL,
      
      ask_open NUMERIC NOT NULL,
      ask_high NUMERIC NOT NULL,
      ask_low NUMERIC NOT NULL,
      ask_close NUMERIC NOT NULL,
      
      volume INTEGER,
      complete BOOLEAN NOT NULL,
      source TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      
      CONSTRAINT uq_oanda_bid_ask_candles UNIQUE (instrument, granularity, time, source),
      
      CONSTRAINT chk_bid_extrema CHECK (bid_high >= bid_open AND bid_high >= bid_close AND bid_high >= bid_low AND bid_low <= bid_open AND bid_low <= bid_close),
      CONSTRAINT chk_ask_extrema CHECK (ask_high >= ask_open AND ask_high >= ask_close AND ask_high >= ask_low AND ask_low <= ask_open AND ask_low <= ask_close),
      CONSTRAINT chk_ask_ge_bid CHECK (ask_open >= bid_open AND ask_high >= bid_high AND ask_low >= bid_low AND ask_close >= bid_close),
      CONSTRAINT chk_complete_true CHECK (complete = true)
    );
  `,
};
