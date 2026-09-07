import type { Migration } from "../migration-runner.js";

export const addExcludedFromEvidenceMigration: Migration = {
  id: "040-add-excluded-from-evidence",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS excluded_from_evidence BOOLEAN NOT NULL DEFAULT false;

    -- Exclude the fictional trades matching BANKNIFTY on 2026-08-04
    UPDATE paper_trades
    SET excluded_from_evidence = true
    WHERE underlying_symbol = 'BANKNIFTY' 
      AND option_expiry = '2026-08-04';
  `,
};
