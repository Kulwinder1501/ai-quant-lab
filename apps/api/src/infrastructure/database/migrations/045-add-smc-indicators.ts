import type { Migration } from "../migration-runner.js";

export const addSmcIndicatorsMigration: Migration = {
  id: "045-add-smc-indicators",
  sql: `
    ALTER TABLE indicator_definitions
    DROP CONSTRAINT IF EXISTS indicator_definitions_indicator_code_check;

    ALTER TABLE indicator_definitions
    ADD CONSTRAINT indicator_definitions_indicator_code_check 
    CHECK (indicator_code IN ('EMA', 'SMA', 'RSI', 'MACD', 'ATR', 'VWAP', 'BOLLINGER_BANDS', 'SUPERTREND', 'FVG', 'BOS'));
  `,
};
