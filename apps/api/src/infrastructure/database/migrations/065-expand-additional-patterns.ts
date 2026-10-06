import type { Migration } from "../migration-runner.js";

export const expandAdditionalPatternsMigration: Migration = {
  id: "065-expand-additional-patterns",
  sql: `
    -- Expand pattern_definitions check constraint with INVERTED_HAMMER and SPINNING_TOP
    ALTER TABLE pattern_definitions DROP CONSTRAINT IF EXISTS pattern_definitions_pattern_code_check;
    ALTER TABLE pattern_definitions
      ADD CONSTRAINT pattern_definitions_pattern_code_check
      CHECK (pattern_code IN (
        'DOJI',
        'DRAGONFLY_DOJI',
        'GRAVESTONE_DOJI',
        'HAMMER',
        'INVERTED_HAMMER',
        'HANGING_MAN',
        'SHOOTING_STAR',
        'SPINNING_TOP',
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

    -- Expand price_action_events check constraint with HEAD_AND_SHOULDERS, INVERSE_HEAD_AND_SHOULDERS, RISING_WEDGE, FALLING_WEDGE
    ALTER TABLE price_action_events DROP CONSTRAINT IF EXISTS price_action_events_event_type_check;
    ALTER TABLE price_action_events
      ADD CONSTRAINT price_action_events_event_type_check
      CHECK (event_type IN (
        'BREAKOUT',
        'BREAKDOWN',
        'SUPPORT',
        'RESISTANCE',
        'UPTREND',
        'DOWNTREND',
        'RANGE',
        'PULLBACK',
        'SWING_HIGH',
        'SWING_LOW',
        'DOUBLE_BOTTOM',
        'DOUBLE_TOP',
        'BULL_FLAG',
        'BEAR_FLAG',
        'ASCENDING_TRIANGLE',
        'DESCENDING_TRIANGLE',
        'HEAD_AND_SHOULDERS',
        'INVERSE_HEAD_AND_SHOULDERS',
        'RISING_WEDGE',
        'FALLING_WEDGE'
      ));
  `,
};
