import type { Migration } from "../migration-runner.js";

/**
 * Dense ATM option premium observations for scalping marks (Phase 27 step 1).
 *
 * Distinct from `option_chain_snapshots` (full book ~every 15m). This table holds
 * a narrow ATM band polled every 15–30s so stops/exits can be marked against a
 * book that is not a quarter-hour stale. Forward-accumulating only — no backfill.
 */
export const optionPremiumTicksMigration: Migration = {
  id: "054-option-premium-ticks",
  sql: `
    CREATE TABLE IF NOT EXISTS option_premium_ticks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      underlying_symbol TEXT NOT NULL CHECK (length(trim(underlying_symbol)) > 0),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      observed_at TIMESTAMPTZ NOT NULL,
      expiry_date DATE NOT NULL,
      strike_price NUMERIC(20, 4) NOT NULL CHECK (strike_price > 0),
      option_type TEXT NOT NULL CHECK (option_type IN ('CE', 'PE')),
      provider_symbol TEXT NOT NULL CHECK (length(trim(provider_symbol)) > 0),
      last_price NUMERIC(20, 4),
      bid NUMERIC(20, 4),
      ask NUMERIC(20, 4),
      volume BIGINT CHECK (volume IS NULL OR volume >= 0),
      underlying_value NUMERIC(20, 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS option_premium_ticks_identity_idx
    ON option_premium_ticks (
      underlying_symbol, observed_at, expiry_date, strike_price, option_type
    );

    CREATE INDEX IF NOT EXISTS option_premium_ticks_latest_idx
    ON option_premium_ticks (underlying_symbol, provider_symbol, observed_at DESC);

    CREATE INDEX IF NOT EXISTS option_premium_ticks_contract_idx
    ON option_premium_ticks (
      underlying_symbol, expiry_date, strike_price, option_type, observed_at DESC
    );

    COMMENT ON TABLE option_premium_ticks IS
      'Dense ATM option premium polls (15-30s). Forward-accumulating; marks for scalp-speed exits. Not a full chain.';
  `,
};
