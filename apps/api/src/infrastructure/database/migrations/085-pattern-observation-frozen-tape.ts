import type { Migration } from "../migration-runner.js";

/**
 * Names the observations that were recorded on a frozen index bar, without deleting one of them.
 *
 * ## What went wrong
 *
 * `pattern-intelligence/domain/bar-integrity.ts` refused a frozen bar with `zero range AND unusable
 * volume` — a conjunction calibrated on 2026-08-25, when the daily 15:16-15:29 IST index freeze
 * carried zero volume throughout. The feed then began stamping constituent volume on the pinned
 * price, and the conjunction stopped firing. Measured on NIFTY50 1m, 2026-08-31, pinned at 24050.25:
 * it refused 4 of 13 frozen bars and admitted 9. The admitted ones were observed, chiefly as
 * `COMPRESSION_EXPANSION` (a flat bar is trivially an inside bar) and including a NIFTY50 5m
 * `HEAD_AND_SHOULDERS` at 15:20 carrying `volume_zscore` 4.23 on a bar with no price range at all.
 *
 * The predicate is now volume-blind for the frozen case, delegating to
 * `market-data/domain/tape-liveness.ts`. This migration is about the rows already written.
 *
 * ## Why a view instead of a DELETE or a rebuild
 *
 * Both precedents in this repository were considered. The bar-0 correction invalidated and rebuilt
 * 10,204 Pattern Intelligence research rows, because every one of them shared a single wrong
 * `earliest_execution_at` that would have contaminated every forward measurement taken from them.
 * Migration 078 reasons the other way: a wrong-but-identifiable row can be more honest than an erased
 * one, because the erasure is itself unrecorded.
 *
 * This case belongs with 078. The affected rows are 25 of 29,241, they are identifiable by a
 * deterministic property of the bar they sit on rather than by a guess, and nothing downstream has
 * yet consumed them into a settled measurement. Deleting them would destroy the evidence that the
 * detector once emitted on a frozen tape — which is the only record of how long the defect ran and
 * how much it produced. So the rows stay and become addressable.
 *
 * `observation_hash` is untouched by design: these are immutable records, and the rows are wrong
 * about the market, not corrupt as records.
 *
 * ## The rule the view encodes
 *
 * Zero range, and all four OHLC values identical to the *time-contiguous* predecessor bar. Both
 * halves are load-bearing, and this is the same rule the runtime predicate applies:
 *
 * - Volume is deliberately not consulted. On an index it cannot corroborate price freshness: index
 *   volume is a constituent aggregate (correlation 0.877 with summed constituent cash volume), so
 *   constituents keep trading and the counter keeps accumulating while the price aggregate is frozen.
 * - Contiguity excludes an identical pair that straddles a gap or an overnight close, which is a
 *   different defect with its own detector. Without it the view would flag every session open whose
 *   bar happens to repeat the prior close.
 *
 * It deliberately does NOT flag an isolated flat bar on real volume — a dull but genuine print. 254
 * of the 279 observations sitting on a zero-range bar are that shape, which is why "refuse every flat
 * bar" would have been the wrong fix and is the wrong query here.
 *
 * The interval mapping must cover every `CanonicalTimeframe`: an unmapped timeframe makes the CASE
 * `NULL`, the contiguity comparison `NULL`, and the row silently absent from the view. A test asserts
 * the coverage so adding a timeframe cannot quietly shrink this view.
 *
 * Idempotent, and creates no table: `CREATE OR REPLACE VIEW` so a re-run is a no-op rather than a
 * replayed backfill.
 */
export const patternObservationFrozenTapeMigration: Migration = {
  id: "085-pattern-observation-frozen-tape",
  sql: `
    CREATE OR REPLACE VIEW pattern_observations_v2_frozen_tape AS
    WITH bars AS (
      SELECT
        c.instrument_id,
        c.timeframe,
        c.open_time,
        c.open, c.high, c.low, c.close, c.volume,
        LAG(c.open)      OVER w AS prev_open,
        LAG(c.high)      OVER w AS prev_high,
        LAG(c.low)       OVER w AS prev_low,
        LAG(c.close)     OVER w AS prev_close,
        LAG(c.open_time) OVER w AS prev_open_time
      FROM candles c
      WINDOW w AS (PARTITION BY c.instrument_id, c.timeframe ORDER BY c.open_time)
    )
    SELECT
      o.observation_id,
      o.instrument_id,
      i.symbol,
      o.timeframe,
      o.pattern_family,
      o.pattern_subtype,
      o.orientation,
      o.detected_at,
      o.volume_zscore,
      o.range_atr,
      o.engine_version,
      o.observation_hash,
      o.logical_key,
      -- The evidence, carried on the row so a reader need not re-derive it.
      b.close  AS pinned_price,
      b.volume AS bar_volume
    FROM pattern_observations_v2 o
    JOIN bars b
      ON  b.instrument_id = o.instrument_id
      AND b.timeframe     = o.timeframe
      AND b.open_time     = o.detected_at
    JOIN instruments i
      ON i.id = o.instrument_id
    WHERE b.high = b.low
      AND b.open  = b.prev_open
      AND b.high  = b.prev_high
      AND b.low   = b.prev_low
      AND b.close = b.prev_close
      AND b.open_time - b.prev_open_time = CASE b.timeframe
        WHEN '1m'  THEN INTERVAL '1 minute'
        WHEN '3m'  THEN INTERVAL '3 minutes'
        WHEN '5m'  THEN INTERVAL '5 minutes'
        WHEN '10m' THEN INTERVAL '10 minutes'
        WHEN '15m' THEN INTERVAL '15 minutes'
        WHEN '30m' THEN INTERVAL '30 minutes'
        WHEN '60m' THEN INTERVAL '60 minutes'
        WHEN '1d'  THEN INTERVAL '1 day'
      END;

    COMMENT ON VIEW pattern_observations_v2_frozen_tape IS
      'Observations detected on a bar that republished its predecessor (the daily index feed freeze). '
      'Wrong about the market, retained as evidence -- see migration 085. Exclude these from any '
      'measurement over pattern_observations_v2.';
  `,
};
