import type { Migration } from "../migration-runner.js";

/**
 * Let a LONG's stop sit ABOVE its entry, so a trailed stop can lock in profit.
 *
 * ## What this unblocks, and why it is not a loosening
 *
 * The old `paper_trades_check` required `stop_loss < entry_price` for a LONG (and the mirror for a
 * SHORT). That is a correct statement about a trade **as it is opened** and a wrong one about a trade
 * **as it runs**: a stop that has been trailed up past entry is not a malformed trade, it is the
 * entire point of trailing. The constraint was applied to the mutable column, so it silently capped
 * every trail in the system at break-even.
 *
 * That cap was not theoretical. Measured 2026-09-22 by replaying the stored option premium ticks of
 * all 439 closed option trades: a `trail 0.5R/0.25R` policy and a plain `break-even @0.5R` policy
 * produce the **identical** book, to the rupee (+9,632.96 against the recorded baseline, both). Every
 * trailing result this project has ever recorded -- including the NO_EDGE verdict in
 * `protective-stop.ts` (BANKNIFTY -63.08 -> -64.03/trade, t=-2.63) -- was therefore a result about
 * break-even wearing a trail's name. `underlying-protective-stop.ts` carried the same ceiling, so the
 * backtester agreed with the live path for the same wrong reason.
 *
 * The opening invariant is not dropped, it is **moved to the column that actually means it**:
 * `initial_stop_loss`, added by 106 and NOT NULL since, records the stop the trade opened with and
 * never changes. Checking it there enforces exactly what the old constraint was trying to say, while
 * leaving `stop_loss` free to be tightened past entry. `stop_loss > 0` is kept by
 * `paper_trades_stop_loss_check`, which this migration does not touch, so a nonsense value is still
 * refused.
 *
 * ## Safety of the rewrite on existing rows
 *
 * Every existing row satisfies the new form: 106 backfilled `initial_stop_loss = stop_loss` at a
 * point when no stop had ever moved in production, and every row passed the old constraint on
 * `stop_loss`. Postgres validates the new CHECK against the whole table as it is added, so a row that
 * did not satisfy it would fail this migration loudly rather than be admitted.
 *
 * Adding the constraint under its original name keeps `pg_constraint` readable -- see the memory note
 * that constraint names must be verified live rather than inferred from SQL text; this one is named
 * explicitly for that reason, instead of letting Postgres auto-name a second `paper_trades_check1`.
 */
export const paperTradeProfitLockingStopMigration: Migration = {
  id: "117-paper-trade-profit-locking-stop",
  sql: `
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_check;

    ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_check CHECK (
      (
        side = 'LONG'
        AND target_price > entry_price
        AND initial_stop_loss < entry_price
      )
      OR
      (
        side = 'SHORT'
        AND target_price < entry_price
        AND initial_stop_loss > entry_price
      )
    );
  `,
};
