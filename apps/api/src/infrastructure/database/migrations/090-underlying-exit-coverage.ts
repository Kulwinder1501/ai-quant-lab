import type { Migration } from "../migration-runner.js";

/**
 * Corrects `underlying_exit_price`'s column comment after its coverage was widened.
 *
 * ## Why a migration rather than editing 089
 *
 * 089 is already applied, so the runner will never replay it -- editing its SQL would leave the
 * database holding the old text while the source showed the new, which is exactly the drift the
 * migration ledger exists to prevent. Same reasoning as the 078 reconciliation.
 *
 * ## What changed, and how the gap was found
 *
 * 089 wired the level from the observed-tick barrier scan only, and its comment said a live-price
 * close had no sample to take one from. Measuring the first close after deployment showed that was
 * too narrow: trade `3281d819` closed at 09:45 IST on 2026-09-02 through `MOMENTUM_STALL_EVALUATOR`
 * and recorded nothing.
 *
 * Counted across the 339 closes then stored, by recorded `fillRule` and `source`:
 *
 * ```
 * OBSERVED_TICK_STOP    OPTION_PREMIUM_TICK_SERIES   152   covered by 089
 * OBSERVED_TICK_TARGET  OPTION_PREMIUM_TICK_SERIES    87   covered by 089
 * (none)                MOMENTUM_STALL_EVALUATOR      97   MISSED -- 29% of all closes
 * (none)                SERVER_OPTION_MARK             3   manual, legitimately absent
 * ```
 *
 * The stall path already held the answer: its exit price is `denseQuote.bid`, and that same tick
 * carries `underlyingValue`. So the level was one field away on 29% of closes and was being dropped.
 *
 * Four paths now record it. Three take the underlying from the *same tick* as the option price, so
 * both legs describe one instant: the barrier scan's crossing sample, the live-bid barrier close, and
 * the momentum-stall close. The fourth, `OPTION_LIVE_MARK_EVALUATOR`, records the observed `liveSpot`
 * even though its option premium is modelled -- the two are independent, and an observed underlying
 * level stays observed regardless of how the premium beside it was derived. The option leg's
 * provenance travels separately, so nothing reads a modelled premium as a fill because of it.
 *
 * Still null, by design: a manual close (no paired observation exists), intrinsic expiry settlement
 * and the completed-candle fallback (their spot can come from a candle close, which is a
 * reconstruction rather than an observation at the exit instant), and every row closed before 089.
 *
 * Idempotent: `COMMENT ON` is a replace.
 */
export const underlyingExitCoverageMigration: Migration = {
  id: "090-underlying-exit-coverage",
  sql: `
    COMMENT ON COLUMN paper_trades.underlying_exit_price IS
      'The underlying''s observed level at the exit instant. Recorded by four close paths: the '
      'observed-tick barrier scan, the live-bid barrier close and the momentum-stall close all take '
      'it from the same option_premium_ticks row as the option price, so both legs describe one '
      'instant; OPTION_LIVE_MARK_EVALUATOR records the observed live spot beside a modelled premium, '
      'whose provenance travels separately in the close event. Point-in-time correct: no unclosed '
      'bar is consulted. NULL means no underlying level was observed -- a manual close, intrinsic '
      'expiry settlement, the completed-candle fallback, or a trade closed before migration 089 -- '
      'and never zero. Not backfilled, so a non-null value was always observed at the close. Pairs '
      'with underlying_entry_price from migration 044. See migrations 089 and 090.';
  `,
};
