import type { Migration } from "../migration-runner.js";

/**
 * Point-in-time option-chain observations: the raw rows, before any derived feature.
 *
 * Phase 25's Workstream D3 is explicit that raw observations are stored first and
 * features derived later, so this table holds what the provider said and nothing
 * computed. PCR, skew, ATM IV and max pain are all reconstructible from these rows;
 * storing them here instead would freeze one definition of each into history.
 *
 * These snapshots close four gaps that had no data at all: open interest and its
 * change, traded volume per contract, the bid-ask spread, and the real expiry
 * calendar. The spread is the load-bearing one -- a straddle's edge was measured at
 * +0.117% of spot against a mean premium of 2.70%, so it dies at roughly 1.09% cost
 * per leg, and until now nothing in the project could measure a spread at all.
 *
 * **Forward-accumulating only.** A chain endpoint returns the current book. There is
 * no historical option-chain source here, and Workstream D3 prohibits scraping today's
 * page and presenting those values as though they existed in the past. Every row is
 * therefore stamped with when it was actually received, and history only deepens from
 * the moment collection starts.
 *
 * `observed_at` is a receipt timestamp. Fyers returns no provider or exchange clock in
 * this payload, so the honest record is "when we read it" -- not a borrowed timestamp
 * that would imply an exchange-side precision the data does not have.
 */
export const optionChainSnapshotsMigration: Migration = {
  id: "037-option-chain-snapshots",
  sql: `
    CREATE TABLE IF NOT EXISTS option_chain_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Canonical lab symbol (NIFTY50, BANKNIFTY, SBIN), not the provider's spelling,
      -- so a provider change does not fragment the series.
      underlying_symbol TEXT NOT NULL CHECK (length(trim(underlying_symbol)) > 0),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      -- Receipt time. See the note above on why there is no provider clock.
      observed_at TIMESTAMPTZ NOT NULL,
      expiry_date DATE NOT NULL,
      -- WEEKLY or MONTHLY, as the provider flags it. Recorded rather than inferred from
      -- the date: NSE moved weeklies to a single index and to Tuesday, so any rule
      -- derived from a weekday would already be stale.
      expiry_kind TEXT NOT NULL CHECK (expiry_kind IN ('WEEKLY', 'MONTHLY')),
      strike_price NUMERIC(20, 4) NOT NULL CHECK (strike_price > 0),
      option_type TEXT NOT NULL CHECK (option_type IN ('CE', 'PE')),
      -- The provider's own contract identifiers, kept so a row can be traced back to
      -- the exact instrument that was quoted.
      provider_symbol TEXT NOT NULL CHECK (length(trim(provider_symbol)) > 0),
      provider_token TEXT,
      -- Every price is nullable: an illiquid strike genuinely has no bid, and a zero
      -- would claim someone was willing to pay nothing rather than that nobody quoted.
      last_price NUMERIC(20, 4),
      bid NUMERIC(20, 4),
      ask NUMERIC(20, 4),
      volume BIGINT CHECK (volume IS NULL OR volume >= 0),
      open_interest BIGINT CHECK (open_interest IS NULL OR open_interest >= 0),
      previous_open_interest BIGINT CHECK (previous_open_interest IS NULL OR previous_open_interest >= 0),
      -- Signed: falling OI is as informative as rising OI, and Phase 25 notes change in
      -- OI is more useful than the absolute level.
      open_interest_change BIGINT,
      -- Spot at observation, so a strike's moneyness is reconstructible later without
      -- joining to a candle whose close may not align with this receipt time.
      underlying_value NUMERIC(20, 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per contract per observation, so re-running a collection inside the same
    -- snapshot is idempotent rather than doubling the book.
    CREATE UNIQUE INDEX IF NOT EXISTS option_chain_snapshots_identity_idx
    ON option_chain_snapshots (underlying_symbol, observed_at, expiry_date, strike_price, option_type);

    -- The dominant read: the latest book for one underlying and expiry.
    CREATE INDEX IF NOT EXISTS option_chain_snapshots_latest_idx
    ON option_chain_snapshots (underlying_symbol, expiry_date, observed_at DESC);

    -- Time series of a single contract, for OI-change and spread history.
    CREATE INDEX IF NOT EXISTS option_chain_snapshots_contract_idx
    ON option_chain_snapshots (underlying_symbol, expiry_date, strike_price, option_type, observed_at DESC);

    COMMENT ON TABLE option_chain_snapshots IS
      'Raw point-in-time option-chain observations. Forward-accumulating: no historical source exists and none may be fabricated. Derived features (PCR, skew, ATM IV, max pain) are computed from these rows, never stored in place of them.';
    COMMENT ON COLUMN option_chain_snapshots.observed_at IS
      'Receipt time. The provider returns no exchange or provider clock in this payload.';
  `,
};
