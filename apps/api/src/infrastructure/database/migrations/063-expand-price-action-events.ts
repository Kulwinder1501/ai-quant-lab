import type { Migration } from "../migration-runner.js";

export const expandPriceActionEventsMigration: Migration = {
  id: "063-expand-price-action-events",
  sql: `
    ALTER TABLE price_action_events DROP CONSTRAINT IF EXISTS price_action_events_event_type_check;
    ALTER TABLE price_action_events ADD CONSTRAINT price_action_events_event_type_check CHECK (event_type IN (
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
      'DESCENDING_TRIANGLE'
    ));
  `,
};
