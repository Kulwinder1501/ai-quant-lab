import type { Migration } from "../migration-runner.js";

/**
 * Adds `BACKFILLED_FROM_QUOTE_OBSERVED_AT` to `paper_trades.underlying_fill_price_source`'s
 * CHECK constraint (migration 120).
 *
 * ## The defect this corrects
 *
 * `backfill-underlying-fill-price.ts` (added alongside migration 120) reconstructed
 * `underlying_fill_price` by finding the `option_premium_ticks` row NEAREST IN TIME to
 * `opened_at`. But the tick that actually priced the fill is separately, reliably recorded on
 * every trade at `fee_breakdown->'entryChecks'->>'quoteObservedAt'` (see
 * `prepare-option-entry.ts`'s `observedFill.observedAt`) -- and "nearest to `opened_at`" is not
 * the same instant as "the tick that priced the fill" whenever there was material lag between the
 * quote and the fill, which is exactly the failure mode `prepare-option-entry.ts`'s quote
 * staleness gate exists to bound.
 *
 * Confirmed live on trade `535e5951-56e3-4323-b8af-f47e5f6812c5` (AutoBot-Scalp1m, BANKNIFTY
 * 54900 CE): `quoteObservedAt` = 2026-10-01T04:04:01.257Z, whose `option_premium_ticks` row reads
 * `underlying_value = 54862.45`. The nearest-to-`opened_at` heuristic instead picked the tick at
 * 2026-10-01T04:04:01.526 + ~60s later (`opened_at` = 04:05:01.526), landing on
 * `underlying_value = 54793.85` -- a different tick describing a different market, selected only
 * because it happened to be closer in clock time to `opened_at`, not because it priced anything.
 *
 * ## Why this needs a new source value rather than reusing an existing one
 *
 * `OPTION_PREMIUM_TICK_ASK` / `OPTION_CHAIN_QUOTE` mean (migration 120's comment) "observed in
 * real time, from the same quote that filled the option" -- i.e. written at insert time, by the
 * live fill path, not reconstructed after the fact. A `quoteObservedAt`-matched backfill is more
 * accurate than `BACKFILLED_NEAREST_TICK` (it recovers the exact tick that priced the fill rather
 * than whichever tick happens to sit closest to `opened_at`), but it is still a backfill: run
 * after the trade closed, from stored JSON, not from a live observation at insert time. Reusing
 * `OPTION_PREMIUM_TICK_ASK` here would erase the very distinction migration 120 was written to
 * protect -- "non-null" would stop reliably meaning "this was actually observed live" for a
 * second time, on the same column, within the same day. `BACKFILLED_FROM_QUOTE_OBSERVED_AT` keeps
 * three provenance tiers honestly distinguishable: observed live, backfilled from the exact
 * pricing tick, and backfilled from merely the nearest tick in clock time.
 *
 * Idempotent: drops and recreates the CHECK by its live name
 * (`paper_trades_underlying_fill_price_source_check`, confirmed via `pg_constraint` rather than
 * assumed from the migration 120 SQL text -- Postgres auto-names an inline `CHECK` after the
 * column, and that name is a load-bearing fact, not a guess) and the `DROP ... IF EXISTS` / `ADD`
 * pair is safe to run more than once.
 */
export const paperTradeUnderlyingFillQuoteObservedSourceMigration: Migration = {
  id: "122-paper-trade-underlying-fill-quote-observed-source",
  sql: `
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_underlying_fill_price_source_check;
    ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_underlying_fill_price_source_check
      CHECK (underlying_fill_price_source IS NULL OR underlying_fill_price_source IN (
        'OPTION_PREMIUM_TICK_ASK', 'OPTION_CHAIN_QUOTE', 'BACKFILLED_NEAREST_TICK',
        'BACKFILLED_FROM_QUOTE_OBSERVED_AT'
      ));

    COMMENT ON COLUMN paper_trades.underlying_fill_price_source IS
      'Provenance of underlying_fill_price. OPTION_PREMIUM_TICK_ASK / OPTION_CHAIN_QUOTE: observed '
      'in real time, from the same quote that filled the option. BACKFILLED_FROM_QUOTE_OBSERVED_AT: '
      'reconstructed after the fact from the exact option_premium_ticks row matching '
      'fee_breakdown.entryChecks.quoteObservedAt -- the real tick that priced the fill. '
      'BACKFILLED_NEAREST_TICK: reconstructed after the fact from the nearest option_premium_ticks '
      'row to opened_at, used only when quoteObservedAt is missing or unmatched -- a weaker claim, '
      'since "nearest to opened_at" is not necessarily the tick that priced the fill. NULL exactly '
      'when underlying_fill_price is NULL.';
  `,
};
