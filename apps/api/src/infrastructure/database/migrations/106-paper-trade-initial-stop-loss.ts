import type { Migration } from "../migration-runner.js";

/**
 * The stop a trade OPENED with, kept separately from the stop currently in force.
 *
 * `stop_loss` moves: the 1m momentum scalp advances it to break-even at +0.5R. The stall rule then
 * recomputed the trade's risk from that moved stop -- `initialRisk = entry - stop_loss` -- so once
 * break-even fired, risk collapsed toward zero, `reward / risk` blew past the `<= 1.6` scalp test,
 * and the 10-minute time stop silently stopped applying to exactly the trades that had reached
 * +0.5R and then died. That is the failure that withdrew momentum-scalp V4, where a 2.0R geometry
 * put every trade outside the same gate.
 *
 * Backfill is exact rather than approximate: measured 2026-09-09, **0 of 414** paper trades have
 * ever had `stop_loss_effective_at > opened_at`, so no stop has ever moved in production and
 * `initial_stop_loss = stop_loss` is the true opening value for every existing row. Had any stop
 * moved, the original would have been unrecoverable -- `updateStopLoss` appends the NEW level to
 * `notes` and keeps no prior value -- so this backfill is only sound because it ran before the
 * feature ever fired.
 *
 * NOT NULL is set after the backfill, so the column cannot silently accept a row that forgot it.
 */
export const paperTradeInitialStopLossMigration: Migration = {
  id: "106-paper-trade-initial-stop-loss",
  sql: `
    ALTER TABLE paper_trades
      ADD COLUMN IF NOT EXISTS initial_stop_loss NUMERIC(20,6);

    UPDATE paper_trades
    SET initial_stop_loss = stop_loss
    WHERE initial_stop_loss IS NULL;

    ALTER TABLE paper_trades
      ALTER COLUMN initial_stop_loss SET NOT NULL;
  `,
};
