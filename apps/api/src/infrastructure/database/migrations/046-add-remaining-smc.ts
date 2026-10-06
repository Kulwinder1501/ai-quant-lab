import type { Migration } from "../migration-runner.js";

export const addRemainingSmcMigration: Migration = {
  id: "046-add-remaining-smc",
  sql: `
    ALTER TABLE indicator_definitions
    DROP CONSTRAINT IF EXISTS indicator_definitions_indicator_code_check;

    ALTER TABLE indicator_definitions
    ADD CONSTRAINT indicator_definitions_indicator_code_check 
    CHECK (indicator_code IN (
      'EMA', 'SMA', 'RSI', 'MACD', 'ATR', 'VWAP', 'BOLLINGER_BANDS', 'SUPERTREND', 
      'FVG', 'BOS', 'CHOCH', 'LIQUIDITY_SWEEP', 'ORDER_BLOCK', 'EQUILIBRIUM_ZONE'
    ));
  `,
};
