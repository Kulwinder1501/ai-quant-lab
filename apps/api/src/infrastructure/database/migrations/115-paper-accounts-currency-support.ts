import type { Migration } from "../migration-runner.js";

/**
 * Widens `paper_accounts.currency` from a hard-pinned `'INR'` so a USD-quoted account
 * (AutoBot-Gold, trading XAU_USD direct-fill against Twelve Data data) can be created.
 * Mirrors migration 113's widening of `instruments.currency` for the same reason.
 */
export const paperAccountsCurrencySupportMigration: Migration = {
  id: "115-paper-accounts-currency-support",
  sql: `
    ALTER TABLE paper_accounts DROP CONSTRAINT paper_accounts_currency_check;
    ALTER TABLE paper_accounts ADD CONSTRAINT paper_accounts_currency_check
      CHECK (currency IN ('INR', 'USD'));
  `,
};
