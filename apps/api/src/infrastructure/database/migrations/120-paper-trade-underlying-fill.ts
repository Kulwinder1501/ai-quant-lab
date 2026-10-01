import type { Migration } from "../migration-runner.js";

/**
 * Adds `paper_trades.underlying_fill_price`, the real underlying spot at the moment the option
 * actually filled -- distinct from `underlying_entry_price`, which is the signal-time level.
 *
 * ## The defect this corrects
 *
 * `underlying_entry_price` (migration 044) is populated from `idea.entry_price` in
 * `prepare-option-entry.ts` -- the underlying's level on the signal candle, not the level at the
 * moment the trade actually got filled. Acceptance checks, sizing and cadence put real lag between
 * the two, and the underlying moves in that window. Confirmed against `option_premium_ticks` (which
 * samples the real underlying every ~5s, including at the fill instant) on 8 recent BANKNIFTY
 * trades: gaps of 19 to 158 points. Trade `1cecb6fe-cb1c-4a90-a06b-9bd34ae5abc6` recorded
 * `underlying_entry_price = 54459.0` while the real tick at its actual fill instant (07:50:03 UTC)
 * read `underlying_value = 54381.85` -- a 77-point gap that led a human reviewer to conclude "the
 * underlying barely moved" on a trade that was, in fact, down ~79 points against the position.
 *
 * `underlying_entry_price` is not renamed and not repointed. Elsewhere it is the correct number:
 * every V2.2 thesis-anchor use (`UnderlyingOutcome.entryReference`, `thesis-builder.ts`,
 * `risk-approver.ts`, `edge-assessor.ts`, ...) means "the level the decision/stop/target were
 * computed from", which is the signal candle by construction, not the fill. This migration adds a
 * second, narrower column for the question those consumers do not ask: "where was the underlying
 * when the position actually opened?"
 *
 * ## Where the value comes from, and why it needs no new collection
 *
 * Same shape as migration 089's `underlying_exit_price`. The live fill path
 * (`prepare-option-entry.ts` -> `mapIdeaToOptionBuyerFill`) already reads a real-time quote to fill
 * the *option* leg -- `option_premium_ticks.underlying_value` (dense ATM tick, ~every 15-30s) or, as
 * a fallback, the option chain snapshot's own `underlying_value` (full-book read, ~every 15m). Both
 * already carry the real underlying spot at that observation; it was simply never threaded onto the
 * persisted trade as its own field. This migration adds the column and the application code now
 * carries that same value through rather than inventing a new source.
 *
 * ## `underlying_fill_price_source`, and why it exists
 *
 * Every other observed-price column in this table (`underlying_exit_price`, migrations 089/090) is
 * deliberately *never* backfilled, specifically so that "non-null" can mean "this was actually
 * observed in real time" without qualification -- see migration 091's note contrasting a price
 * claim with a version label. This field breaks that pattern on purpose: a one-off backfill (see the
 * accompanying CLI script) reconstructs it for historical trades from the nearest
 * `option_premium_ticks` row to `opened_at`, within a tight staleness bound. Backfilling without a
 * provenance marker would quietly erase the exact distinction those migrations were written to
 * protect, so this column exists to keep it: 'OPTION_PREMIUM_TICK_ASK' / 'OPTION_CHAIN_QUOTE' mean
 * "observed at the fill, same tick/snapshot as the option premium"; 'BACKFILLED_NEAREST_TICK' means
 * "reconstructed after the fact from the nearest tick within tolerance" -- a weaker claim that a
 * reader must be able to tell apart from the first two.
 *
 * Nullable like `underlying_exit_price`: null means "no real-time quote or nearby tick was
 * available", never zero.
 *
 * Idempotent: `ADD COLUMN IF NOT EXISTS`, `CHECK` is added with `NOT VALID`-free syntax only because
 * the column is new and empty, and `COMMENT ON` is a replace.
 */
export const paperTradeUnderlyingFillMigration: Migration = {
  id: "120-paper-trade-underlying-fill",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_fill_price NUMERIC(20, 4);
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_fill_price_source TEXT
      CHECK (underlying_fill_price_source IS NULL OR underlying_fill_price_source IN (
        'OPTION_PREMIUM_TICK_ASK', 'OPTION_CHAIN_QUOTE', 'BACKFILLED_NEAREST_TICK'
      ));

    COMMENT ON COLUMN paper_trades.underlying_fill_price IS
      'The underlying''s real observed level at the instant the option actually filled -- distinct '
      'from underlying_entry_price (migration 044), which is the signal-candle level at idea '
      'generation. Populated going forward from the same real-time quote that fills the option leg '
      '(option_premium_ticks.underlying_value, or the option chain snapshot''s underlying_value as a '
      'fallback). NULL means no such observation was available, never zero. Historical trades may '
      'carry a value reconstructed by a one-off backfill from the nearest option_premium_ticks row '
      'within tolerance -- see underlying_fill_price_source to tell the two apart.';

    COMMENT ON COLUMN paper_trades.underlying_fill_price_source IS
      'Provenance of underlying_fill_price. OPTION_PREMIUM_TICK_ASK / OPTION_CHAIN_QUOTE: observed '
      'in real time, from the same quote that filled the option. BACKFILLED_NEAREST_TICK: '
      'reconstructed after the fact from the nearest option_premium_ticks row to opened_at, within '
      'the backfill script''s staleness tolerance. NULL exactly when underlying_fill_price is NULL.';
  `,
};
