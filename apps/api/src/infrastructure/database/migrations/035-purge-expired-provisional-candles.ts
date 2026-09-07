import type { Migration } from "../migration-runner.js";

/**
 * Remove provisional candles whose window closed long ago and that no process
 * can ever finalise.
 *
 * The first data-readiness audit (Phase 25, Workstream A) found dozens of these
 * on every Yahoo intraday series. Their origin: Yahoo's chart API appends the
 * in-progress session bar keyed at the *last trade time* rather than the
 * timeframe grid (an open of 12:26:09 on a 15m series), the historical importer
 * stored it as provisional, and the next fetch returned different keys — so the
 * row could never be matched, completed, or re-collected. It is partial
 * evidence with a fabricated window, invisible to training (which filters
 * `is_complete`) but polluting every coverage measurement.
 *
 * The importer no longer persists in-progress bars at all, so this class of row
 * cannot regrow; this migration removes the accumulated remainder. The one-hour
 * grace — the same tolerance the audit applies — protects any genuinely forming
 * bar owned by the live collector, whose own sweep finalises its bars within
 * the following poll, minutes after the window closes.
 *
 * Same reasoning as 013-purge-fabricated-rsi and 033-purge-seeded-1h-candles:
 * the deletion removes fabricated/unsettleable evidence, not market coverage.
 * Dependent indicator snapshots cascade.
 */
export const purgeExpiredProvisionalCandlesMigration: Migration = {
  id: "035-purge-expired-provisional-candles",
  sql: `
    DELETE FROM candles
    WHERE is_complete = FALSE
      AND close_time < CURRENT_TIMESTAMP - INTERVAL '1 hour';
  `,
};
