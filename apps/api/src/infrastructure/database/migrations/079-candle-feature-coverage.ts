import type { Migration } from "../migration-runner.js";

/**
 * Records that a feature layer was *computed* for a candle, separately from what it found.
 *
 * ## The defect this exists to close
 *
 * `PostgresStrategyMarketContextRepository` builds a strategy context with a bare
 * `WHERE pattern_detections.candle_id = $1` — whatever rows exist at the instant of the call. The
 * scalp research harness runs every minute at :50; `PATTERN_DETECTION_INTRADAY` runs on a
 * quarter-hour cron. A candle closing at 09:31 therefore has no candlestick or price-action features until
 * 09:45, but the harness reads it at 09:31:50 and freezes that read forever.
 *
 * Measured on 2026-08-24 (live) against 2026-08-21 (next-day backfill), comparing each proposal's
 * recorded `raw_context.patterns` with what the tables hold now: the backfilled cohorts under-read on
 * 0 of 473 rows, while the live cohort under-read on 39 of 85 — 46% of evaluations saw *zero*
 * patterns on a candle that has them, and 69% of pattern content was missing at decision time.
 * `MomentumScalpPatternStrategyV2` triggers only on a candlestick pattern, so those minutes could not
 * propose anything regardless of configuration, and the loss was indistinguishable from a quiet
 * market.
 *
 * ## Why a table and not a count
 *
 * Absence of detections is ambiguous by construction: "the engine ran and found nothing" and "the
 * engine has not run" are the same zero rows. No amount of querying `pattern_detections` separates
 * them, which is exactly why the race was invisible for as long as it was. A coverage row is written
 * for every candle in the detection pass's write window whether or not that candle produced a
 * detection, so the zero becomes readable.
 *
 * The two timestamp columns that look like they would answer this do not.
 * `pattern_detections.detected_at` and `indicator_snapshots.calculated_at` are both rewritten by
 * later recompute passes — 845 of 846 of 2026-08-24's 1m detections carry a 15:00-hour stamp, and
 * every indicator row for both sessions reads 2026-08-24 15:59. They record the most recent write,
 * never the first one, so they cannot date a feature's availability.
 *
 * ## No backfill, deliberately
 *
 * Nothing is stamped for history. For every candle already stored we genuinely do not know when its
 * features landed relative to the read, and inventing a coverage row would assert exactly the fact
 * this table exists to establish. An unstamped candle reads as "unknown", which is true.
 *
 * The consumer is written to tolerate that: the harness only ever captures the current session, so
 * unstamped history is never consulted, and a minute whose coverage has not yet arrived is deferred
 * to a later tick rather than captured blind. See `run-scalp-research-harness.ts`.
 */
export const candleFeatureCoverageMigration: Migration = {
  id: "079-candle-feature-coverage",
  sql: `
    CREATE TABLE IF NOT EXISTS candle_feature_coverage (
      candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      feature_layer TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (candle_id, feature_layer, algorithm_version)
    );

    -- The harness asks "is this candle covered for these layers" once per candidate minute, per
    -- instrument. The primary key already serves that lookup; this index serves the reverse question
    -- an audit asks -- "which candles did this layer cover, and when" -- without a sequential scan.
    CREATE INDEX IF NOT EXISTS candle_feature_coverage_layer_idx
      ON candle_feature_coverage (feature_layer, algorithm_version, computed_at);
  `,
};
