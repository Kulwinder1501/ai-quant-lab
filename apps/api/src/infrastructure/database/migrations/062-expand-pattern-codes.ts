import type { Migration } from "../migration-runner.js";

export const expandPatternCodesMigration: Migration = {
  id: "062-expand-pattern-codes",
  sql: `
    ALTER TABLE pattern_definitions DROP CONSTRAINT IF EXISTS pattern_definitions_pattern_code_check;
    ALTER TABLE pattern_definitions ADD CONSTRAINT pattern_definitions_pattern_code_check CHECK (pattern_code IN (
      'DOJI',
      'DRAGONFLY_DOJI',
      'GRAVESTONE_DOJI',
      'HAMMER',
      'HANGING_MAN',
      'SHOOTING_STAR',
      'BULLISH_ENGULFING',
      'BEARISH_ENGULFING',
      'MORNING_STAR',
      'EVENING_STAR',
      'BULLISH_HARAMI',
      'BEARISH_HARAMI',
      'THREE_WHITE_SOLDIERS',
      'THREE_BLACK_CROWS',
      'INSIDE_BAR',
      'OUTSIDE_BAR',
      'PIERCING_LINE',
      'DARK_CLOUD_COVER',
      'TWEEZER_BOTTOM',
      'TWEEZER_TOP',
      'BULLISH_MARUBOZU',
      'BEARISH_MARUBOZU',
      'THREE_INSIDE_UP',
      'THREE_INSIDE_DOWN'
    ));
  `,
};
