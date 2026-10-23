import type { Migration } from "../migration-runner.js";

/**
 * The provider's own Greeks, stored raw beside the chain observation.
 *
 * Migration 037's rule is that this table holds what the provider said and nothing computed. Fyers
 * documents a `greeks=1` flag on the option-chain endpoint that adds delta, gamma, theta, vega and IV to
 * every row, and the repository's comment said "the provider returns no greeks" -- never tested with the
 * flag. Tested 2026-10-23 (NIFTY50, BANKNIFTY, SBIN, one request each) it does return them, and they are
 * not placeholders despite the identical-on-every-row sample in the docs: they vary by strike.
 *
 * What the measurements showed, which is why the columns are shaped as they are:
 *
 * - **Units are the model's own.** IV arrives as a percent (15.30), delta per 1 point of the underlying,
 *   theta in premium per calendar day per unit, vega per 1 vol point. Stored exactly as sent, IV
 *   included, so the unit is the provider's and `vendor_iv_percent` says so in its name.
 * - **One value per strike, shared by call and put.** IV, gamma, theta and vega are identical on both
 *   sides at every strike, and put delta is exactly call delta minus 1. That is a forward-model
 *   (Black-76-style) output, so unlike the model Greeks computed on read, the call and put theta do not
 *   differ by a rate-carry term.
 * - **Close to this repo's own solve** once that solve uses the parity forward: IV within 0.05 vol points
 *   on average, delta within 0.002, vega within 0.1%. The vendor's delta implies an underlying of ~22,585
 *   against our parity pricing spot of 22,581 -- it prices off the market forward, not raw spot.
 * - **Gamma is too coarse to chart.** It is reported to four decimals, which gave BANKNIFTY two distinct
 *   values across seven strikes. Stored as sent; the model gamma, which this table does not hold,
 *   remains the one to display.
 *
 * Why keep them at all, given the model values are close: they are an independent observation, so any
 * drift between them is a signal about our solver or about the provider, and `greeks=1` rides on the
 * request the collector already makes -- no extra requests against the 5,000 a day.
 *
 * Every column is nullable. A row from before this migration, an underlying for which the provider sends
 * no Greeks, and a value that failed the parser's range check are all NULL, and NULL means "not
 * observed", never zero. Forward-accumulating only: there is no backfill, and none may be fabricated.
 *
 * ## Deploy order matters here, because the writer and the migration ship in one image
 *
 * The chain collector INSERTs these columns and the chain read SELECTs them, so the new code fails against a
 * database this migration has not reached ("column vendor_delta does not exist"), and a snapshot that fails to
 * write is gone for good: the series is forward-accumulating. The compose file already orders it correctly --
 * `api-v2` owns migrate-and-seed and `scheduler-v2` waits on `api-v2` being healthy -- so a normal
 * `docker compose up -d --build` is safe. What is not safe is rebuilding the shared image and recreating only
 * `scheduler-v2` while the old `api-v2` container keeps running: the collector would write to columns nothing
 * has created. Recreate `api-v2` first (it migrates on start), then the scheduler. The change is additive and
 * nullable, so old code running against a migrated database is unaffected.
 */
export const optionChainVendorGreeksMigration: Migration = {
  id: "142-option-chain-vendor-greeks",
  sql: `
    ALTER TABLE option_chain_snapshots
      ADD COLUMN IF NOT EXISTS vendor_delta NUMERIC(12, 6),
      ADD COLUMN IF NOT EXISTS vendor_gamma NUMERIC(12, 8),
      ADD COLUMN IF NOT EXISTS vendor_theta NUMERIC(14, 4),
      ADD COLUMN IF NOT EXISTS vendor_vega NUMERIC(14, 4),
      ADD COLUMN IF NOT EXISTS vendor_iv_percent NUMERIC(10, 4);

    COMMENT ON COLUMN option_chain_snapshots.vendor_delta IS
      'Fyers delta as sent (greeks=1): per 1 point of the underlying. One value per strike; put = call - 1. NULL = not observed.';
    COMMENT ON COLUMN option_chain_snapshots.vendor_gamma IS
      'Fyers gamma as sent, to 4 decimals only. NULL = not observed. Too coarse to chart for index options.';
    COMMENT ON COLUMN option_chain_snapshots.vendor_theta IS
      'Fyers theta as sent: premium per calendar day per unit, negative for a long option. One value per strike, shared by call and put.';
    COMMENT ON COLUMN option_chain_snapshots.vendor_vega IS
      'Fyers vega as sent: premium per 1 vol point per unit. NULL = not observed.';
    COMMENT ON COLUMN option_chain_snapshots.vendor_iv_percent IS
      'Fyers implied volatility as sent, in PERCENT (15.30 = 15.30%). One value per strike, shared by call and put. NULL = not observed.';
  `,
};
