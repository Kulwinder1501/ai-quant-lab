import type { Migration } from "../migration-runner.js";

/**
 * Records what `paper_trades.realized_pnl` means, because nothing did.
 *
 * ## What was observed
 *
 * The P11 three-layer reconciliation in `review-closed-trades` reports one residual over the closed
 * book: trade `951a0ecb`, whose residual is exactly its own fees (Rs 30.70) because its
 * `realized_pnl` is gross where every other trade's is net.
 *
 * The obvious reading -- that a full-exit close path books gross while the partial-exit path books
 * net -- was investigated and is **wrong**. There are exactly two writers of `status = 'CLOSED'`,
 * `PostgresPaperTradeRepository.close` and `.executeExitSlice`, and since `fe84dc6` (2026-08-18)
 * they have shared one closing expression: `SUM(paper_trade_partial_exits.realized_pnl)` less the
 * entry fee, where each slice is itself booked net of its own exit fees and slippage. Both zero
 * `remaining_quantity`, both insert a slice, both write a `paper_trade_events` row, both extend
 * `fee_breakdown` with an `exit` key. The image running in production was built 2026-08-27, after
 * that commit. So the paths do not disagree, and no deployed code books gross.
 *
 * What distinguishes `951a0ecb` is that it carries **none** of the five artifacts every close path
 * writes: no close event (only `OPENED`), no slice row, `remaining_quantity` still at its full 75,
 * no `fee_breakdown.exit`, and a P&L equal to raw gross. It is also the only trade in the whole
 * history closed at 19:18 IST, almost four hours after the 15:30 close, at a price exactly equal to
 * its own stop loss. That is a hand-run `UPDATE`, not a code path -- which is why the convention was
 * never written down anywhere a person composing one statement would have read it.
 *
 * ## Why a comment and not a CHECK
 *
 * A CHECK expressing the identity would be the stronger guard, and it cannot be added: `951a0ecb`
 * violates it, and the row is deliberately being kept (see below). Adding the constraint `NOT VALID`
 * was considered and rejected -- a constraint that is documented as unenforced for one row reads as
 * enforced to everyone who greps for it, which is the same failure of legibility this migration
 * exists to fix. The convention is instead asserted two ways: here, where a person writing SQL by
 * hand will see it via `\d+ paper_trades`, and in
 * `postgres-paper-trade-repository.pnl-convention.test.ts`, which fails if the two writers' closing
 * expressions ever stop being identical.
 *
 * ## The one wrong row stays
 *
 * Following migration 078 and 085 rather than the bar-0 correction. The bar-0 rebuild was right
 * because all 10,204 rows shared a single contaminating value that would have propagated into every
 * forward measurement. Here it is one row of 330, its discrepancy is known and exactly quantified,
 * and the reconciliation names it on every run. Repairing the number in place would erase the only
 * evidence that a close once bypassed the application entirely -- and the erasure would itself be
 * unrecorded. It also cannot be made whole: the missing event and slice rows would have to be
 * fabricated, which would misrepresent a manual `UPDATE` as a close the system performed.
 *
 * Consequence, stated so an aggregate is not read naively: `SUM(realized_pnl)` over the closed book
 * is overstated by Rs 30.70, being the fees of that one trade.
 *
 * Idempotent: `COMMENT ON` is a replace, so a re-run is a no-op.
 */
export const paperTradePnlConventionMigration: Migration = {
  id: "088-paper-trade-pnl-convention",
  sql: `
    COMMENT ON COLUMN paper_trades.realized_pnl IS
      'NET of all fees and slippage, entry and exit. Written only by '
      'PostgresPaperTradeRepository.close and .executeExitSlice, which share one expression: '
      'SUM(paper_trade_partial_exits.realized_pnl) - the entry fee from fee_breakdown->entry->>total, '
      'where each slice is already net of its own exit fees and slippage. The gross figure is not '
      'stored; derive it as (exit_price - entry_price) * quantity * side_sign, and note that this '
      'identity holds only because every close to date has been a single full exit. Do not close a '
      'trade with hand-written SQL: trade 951a0ecb was closed that way and is gross, which is the one '
      'residual P11 reports and the reason this comment exists. See migration 088.';

    COMMENT ON COLUMN paper_trades.remaining_quantity IS
      'Unexited quantity. Set to the full quantity at open and to 0 by both close paths, so on a '
      'CLOSED row it is always 0 -- except trade 951a0ecb, closed by hand, where it is stale at the '
      'full 75. Safe to read only under status = ''OPEN''; it is not a reliable test of whether a '
      'position is open. See migration 088.';
  `,
};
