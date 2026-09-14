import type { Migration } from "../migration-runner.js";

/**
 * Source clocks and collector regime for `option_premium_ticks` (collector regime 3).
 *
 * Until now the only timestamp on a premium tick was `observed_at`, stamped by our own process at
 * the socket boundary (`observedAt: this.now()`). Every downstream rule that reads "when was this
 * quote available" — including Phase 29 D2's frozen `first observed ask within 60 s` — has
 * therefore been measuring **collector receipt time**, with no way to audit the difference against
 * the exchange.
 *
 * That was assumed to be a data-availability problem. It is not. Sampled live in-session on
 * 2026-08-24 (`inspect-fyers-socket-payload.ts`, 40 messages, keys only), the Fyers data socket
 * sends 26 fields per message, including `exch_feed_time` and `last_traded_time` — present in every
 * message, never null, both carrying live session times. `parseTick` narrows the payload to five
 * fields before anything downstream sees it, so the exchange clock was arriving and being dropped.
 *
 * This is deliberately **not** the `tt` trap. The HTTP quotes endpoint has a similarly-named field
 * that measured as the session date at UTC midnight for a mid-session equity — present, mapped and
 * useless — and is correctly refused in `fyers-live-market-data-provider.ts`. The socket's field is
 * a different one and was verified to carry session time before this migration was written.
 *
 * ## Nullable, and never backfilled
 *
 * All three columns are nullable with no default, because the ~44k rows already collected genuinely
 * do not have this information and no honest value exists for them. They must stay NULL:
 * reconstructing an exchange time from `observed_at`, from `created_at`, or from the measured 2.6–3.9 s
 * write lag would manufacture precision the data never had, and a guessed exchange timestamp is
 * strictly worse than an explicitly missing one — it would look authoritative in exactly the
 * analysis that most needs to know it is absent.
 *
 * `collector_regime` makes the boundary queryable rather than something a reader has to infer from
 * a date. Existing rows are stamped from their own observation date: the socket streamer landed in
 * `0ee9e88` on 2026-08-16, so sessions before 2026-08-17 came from the HTTP poller and everything
 * from 2026-08-17 to this migration came from the streamer without source clocks.
 *
 * **A NULL `collector_regime` is meaningful, not missing data.** The backfill runs once and stamps
 * only what exists when it runs; a row written afterwards by a collector that does not set the
 * column is genuinely a row whose capture code did not declare a regime. That is the honest reading
 * and it is why the column takes no DEFAULT — a default would silently label rows from any future
 * collector that forgot to stamp, which is the failure this column exists to make visible.
 * In practice it marks the window between this migration applying and the regime-3 collector
 * deploying.
 *
 * ## Granularity, learned from `depth_frames`
 *
 * The sibling table already stores this shape (`sequence_no`, `exchange_feed_time`,
 * `vendor_send_time`, `received_at`) across 44,768 fully-populated rows, and its migration records
 * a caveat that applies here too: the feed's clocks are **second-granularity**. They are adequate
 * for a 60-second eligibility window and cannot support any sub-second latency claim. Keeping our
 * own millisecond `observed_at` alongside them is what makes that limitation visible instead of
 * inviting someone to infer latency from two coarse integers.
 *
 * ## This does not change any running experiment
 *
 * Phase 29 D2 reads `observed_at` and continues to; its execution basis stays
 * `COLLECTOR_RECEIPT_TIME_V1` and its frozen manifest is untouched. These columns are observational
 * provenance for successor protocols (`EXCHANGE_EVENT_TIME_V2`), not a change to execution policy.
 */
export const optionPremiumTickSourceClocksMigration: Migration = {
  id: "078-option-premium-tick-source-clocks",
  sql: `
    ALTER TABLE option_premium_ticks
      ADD COLUMN IF NOT EXISTS exchange_feed_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_trade_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS collector_regime TEXT;

    -- Stamped from each row's own session, not from "now": the regime is a property of when the
    -- row was captured. LEGACY_POLLER_V1 is everything before the streamer landed.
    UPDATE option_premium_ticks
      SET collector_regime = CASE
        WHEN (observed_at AT TIME ZONE 'Asia/Kolkata')::date < DATE '2026-08-17'
          THEN 'LEGACY_POLLER_V1'
        ELSE 'STREAMER_V1_RECEIPT_CLOCK_ONLY'
      END
      WHERE collector_regime IS NULL;

    -- Partial: the interesting query is "which rows carry an exchange clock", and while the
    -- backfilled history is all NULL a full index would be mostly dead weight.
    CREATE INDEX IF NOT EXISTS option_premium_ticks_exchange_feed_time_idx
      ON option_premium_ticks (underlying_symbol, exchange_feed_time)
      WHERE exchange_feed_time IS NOT NULL;

    CREATE INDEX IF NOT EXISTS option_premium_ticks_collector_regime_idx
      ON option_premium_ticks (collector_regime);
  `,
};
