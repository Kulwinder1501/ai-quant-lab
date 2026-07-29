import type { Migration } from "../migration-runner.js";

export const marketNewsSchemaMigration: Migration = {
  id: "004-market-news-schema",
  sql: `
    CREATE TABLE IF NOT EXISTS market_news (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (provider IN ('MONEYCONTROL', 'ECONOMIC_TIMES', 'LIVEMINT', 'NSE')),
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL UNIQUE CHECK (length(trim(url)) > 0),
      published_at TIMESTAMPTZ NOT NULL,
      sentiment_score NUMERIC(5, 4) NOT NULL CHECK (sentiment_score >= -1.0 AND sentiment_score <= 1.0),
      sentiment_label TEXT NOT NULL CHECK (sentiment_label IN ('BULLISH', 'BEARISH', 'NEUTRAL', 'HIGH_VOLATILITY')),
      symbols_mentioned TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS market_news_published_idx ON market_news (published_at DESC);
    CREATE INDEX IF NOT EXISTS market_news_provider_idx ON market_news (provider, published_at DESC);
    CREATE INDEX IF NOT EXISTS market_news_symbols_idx ON market_news USING GIN (symbols_mentioned);
  `,
};
