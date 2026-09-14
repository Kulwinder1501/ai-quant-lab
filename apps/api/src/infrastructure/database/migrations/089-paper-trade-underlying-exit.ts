import type { Migration } from "../migration-runner.js";

/**
 * Adds `paper_trades.underlying_exit_price`, the counterpart migration 044 never added.
 *
 * ## What was missing, and what it cost
 *
 * `underlying_entry_price` has been recorded since migration 044. There was no exit counterpart, so
 * a closed option trade had a start point for the underlying and no end point. Brain P11's
 * three-layer outcome therefore leaves its `underlying` layer null on every legacy trade, and
 * `attributeShortfall` declines to attribute rather than guessing -- which means the one question
 * the split exists to answer, "was the thesis wrong or did the fill erase a correct one?", could not
 * be answered for any trade in the book.
 *
 * ## Where the value comes from, and why it needs no new collection
 *
 * Found by audit rather than assumed: `option_premium_ticks.underlying_value` is already populated
 * on **100% of 606,244 ticks** since 2026-08-12, and the dense reader that resolves an option exit
 * already carries it through to the evaluator as `DenseObservation.underlyingValue`.
 *
 * That matters for correctness, not just convenience. Production exits are resolved from the option's
 * own quoted bid series (`OPTION_PREMIUM_TICK_SERIES`, `OBSERVED_TICK_STOP` / `OBSERVED_TICK_TARGET`),
 * so the exit instant is a tick timestamp rather than a bar boundary. The underlying level recorded
 * here is the one carried on **that same crossing tick**, which makes it point-in-time correct by
 * construction: it was observed at the moment the barrier was crossed, and no bar that had not yet
 * closed was consulted to obtain it.
 *
 * The alternative -- reading the underlying's 1m candle close around the exit -- was rejected. Mid-bar
 * that close is a future value relative to the exit instant, and reconstructing a level to sit beside
 * observed fills is exactly what `legacy-trade-outcome-adapter` refuses to do.
 *
 * ## Nullable, and null means something specific
 *
 * Only the observed-tick path can supply an underlying level from the crossing sample. A close via
 * the live-price evaluator, intrinsic expiry settlement, or a manual close has no such sample, and
 * those rows stay null -- as do all 339 trades closed before this column existed.
 *
 * Null therefore reads as "no underlying level was observed at this exit instant", never as zero.
 * `reconcileOutcome` already treats a wholly absent underlying layer as legitimate and declines
 * attribution for it, so a null row behaves exactly as the whole book behaves today.
 *
 * Deliberately **not** backfilled. The ticks needed to reconstruct most historical exits do exist,
 * but a backfilled value would be indistinguishable from one observed at the close, and the
 * distinction is the entire basis on which this column can be trusted. Precedent: migration 088 left
 * its one wrong row in place rather than repair it silently.
 *
 * Idempotent: `ADD COLUMN IF NOT EXISTS`, and `COMMENT ON` is a replace.
 */
export const paperTradeUnderlyingExitMigration: Migration = {
  id: "089-paper-trade-underlying-exit",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_exit_price NUMERIC(20, 4);

    COMMENT ON COLUMN paper_trades.underlying_exit_price IS
      'The underlying''s observed level at the exit instant, taken from option_premium_ticks.'
      'underlying_value on the same tick that crossed the barrier. Point-in-time correct: no '
      'unclosed bar is consulted. NULL means no underlying level was observed at this exit -- a '
      'live-price, intrinsic-expiry or manual close, or a trade closed before migration 089 -- and '
      'never zero. Not backfilled, so a non-null value was always observed at the close. Pairs with '
      'underlying_entry_price from migration 044.';
  `,
};
