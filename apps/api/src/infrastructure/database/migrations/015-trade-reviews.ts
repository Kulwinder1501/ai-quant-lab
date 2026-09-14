import type { Migration } from "../migration-runner.js";

// An auditable, measured review of each closed trade.
//
// This replaces what trade closure used to produce. The old path wrote two templated
// sentences whose content did not depend on the trade: every profitable close was
// described as having "hit Target Profit" -- inferred from the sign of the P&L while
// the real `exit_reason` sat unread in the same query, which mislabelled all three of
// this database's profitable MANUAL closes -- and every loss proposed the same fixed
// rule about tightening stops when "intraday volume is below its 20-period average",
// a condition never evaluated and unevaluable here, since index intraday volume is
// zero on every bar.
//
// What is stored instead is measured: realised R against the trade's own initial risk,
// and maximum adverse and favourable excursion. Realised P&L says whether a trade
// worked; MAE and MFE say whether its geometry was right -- whether a winner nearly
// stopped out first, whether a loser was in profit before it failed, whether a loss
// exceeded what the stop should have permitted. Reconstructing exactly this from exit
// populations is what diagnosed momentum-scalp's realised 0.58:1 reward-to-risk.
//
// `observed_timeframe` is stored with the excursions because it sets their precision:
// they are read from candle extremes, so they are an upper bound, and a 1d-derived
// excursion is a far coarser statement than a 1m-derived one. A reader must be able
// to tell which they are looking at.
//
// `proposed_research_tags` are inputs to offline research and nothing more. Per the
// improvement plan's 4.4, a trade review must never mutate a live strategy or model;
// aggregation across many trades is what may eventually justify a candidate
// experiment.
export const tradeReviewsMigration: Migration = {
  id: "015-trade-reviews",
  sql: `
    CREATE TABLE IF NOT EXISTS trade_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_id UUID NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,

      outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN')),
      -- Nullable rather than defaulted: a trade with no recorded exit reason is a
      -- fact worth keeping, and inventing one here is what the old path did wrong.
      exit_reason TEXT,

      realized_pnl NUMERIC(20, 6) NOT NULL,
      risk_per_unit NUMERIC(20, 6) NOT NULL CHECK (risk_per_unit > 0),
      realized_r NUMERIC(20, 6) NOT NULL,

      -- Null when no holding-period candle was available. Absent data must stay
      -- distinguishable from a measured zero excursion.
      maximum_adverse_excursion NUMERIC(20, 6) CHECK (maximum_adverse_excursion >= 0),
      maximum_favourable_excursion NUMERIC(20, 6) CHECK (maximum_favourable_excursion >= 0),
      maximum_adverse_excursion_r NUMERIC(20, 6) CHECK (maximum_adverse_excursion_r >= 0),
      maximum_favourable_excursion_r NUMERIC(20, 6) CHECK (maximum_favourable_excursion_r >= 0),

      candles_observed INTEGER NOT NULL CHECK (candles_observed >= 0),
      observed_timeframe TEXT,

      observations JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(observations) = 'array'),
      proposed_research_tags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proposed_research_tags) = 'array'),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- Excursions are only null together, and only when nothing was observed.
      CONSTRAINT trade_reviews_excursions_present_together CHECK (
        (maximum_adverse_excursion IS NULL) = (maximum_favourable_excursion IS NULL)
        AND (maximum_adverse_excursion IS NULL) = (maximum_adverse_excursion_r IS NULL)
        AND (maximum_adverse_excursion IS NULL) = (maximum_favourable_excursion_r IS NULL)
        AND ((maximum_adverse_excursion IS NULL) OR candles_observed > 0)
      )
    );

    -- One review per trade, so re-reviewing a trade refreshes it rather than
    -- accumulating duplicates each time the agent revisits closed trades.
    CREATE UNIQUE INDEX IF NOT EXISTS trade_reviews_trade_idx ON trade_reviews (trade_id);

    -- Aggregating tags across many trades is the whole point of collecting them.
    CREATE INDEX IF NOT EXISTS trade_reviews_tags_idx ON trade_reviews USING gin (proposed_research_tags);

    CREATE INDEX IF NOT EXISTS trade_reviews_created_idx ON trade_reviews (created_at DESC);
  `,
};
