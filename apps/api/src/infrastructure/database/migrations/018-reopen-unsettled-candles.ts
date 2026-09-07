import type { Migration } from "../migration-runner.js";

/**
 * Yahoo historical imports were storing the still-open session bar as
 * `is_complete = TRUE` because every provider row was stamped complete. That
 * made `GenerateTradeIdeas` treat a mid-session print as the latest settled
 * close, and Strategy pages showed either a premature "today" idea or nothing
 * after expired lookback rows crowded the feed.
 *
 * Flip any bar whose close is still ahead of wall clock back to provisional so
 * live collection can resume and strategy evaluation skips it until the session
 * actually settles. Drop PROPOSED ideas that were generated against those
 * premature bars (ACCEPTED/REJECTED history is kept). Settled candles stay put.
 */
export const reopenUnsettledCandlesMigration: Migration = {
  id: "018-reopen-unsettled-candles",
  sql: `
    DELETE FROM trade_ideas
    WHERE status = 'PROPOSED'
      AND source_candle_id IN (
        SELECT id FROM candles
        WHERE is_complete = TRUE
          AND close_time > CURRENT_TIMESTAMP
      );

    UPDATE candles
    SET is_complete = FALSE
    WHERE is_complete = TRUE
      AND close_time > CURRENT_TIMESTAMP
  `,
};
