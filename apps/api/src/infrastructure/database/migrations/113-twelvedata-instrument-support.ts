import type { Migration } from "../migration-runner.js";

/**
 * Widens `instruments.exchange` and `instruments.currency` so a globally-quoted instrument
 * (starting with Twelve Data's `XAU/USD`) can be registered at all. Both were closed to
 * Indian-exchange assumptions from the initial schema: `exchange` only ever allowed
 * `NSE|NFO|BSE`, and `currency` was hard-pinned to `'INR'` -- reasonable when every instrument
 * traded on an Indian exchange, not when the next one is priced in USD by a non-Indian vendor.
 */
export const twelveDataInstrumentSupportMigration: Migration = {
  id: "113-twelvedata-instrument-support",
  sql: `
    ALTER TABLE instruments DROP CONSTRAINT instruments_exchange_check;
    ALTER TABLE instruments ADD CONSTRAINT instruments_exchange_check
      CHECK (exchange IN ('NSE', 'NFO', 'BSE', 'TWELVEDATA'));

    ALTER TABLE instruments DROP CONSTRAINT instruments_currency_check;
    ALTER TABLE instruments ADD CONSTRAINT instruments_currency_check
      CHECK (currency IN ('INR', 'USD'));
  `,
};
