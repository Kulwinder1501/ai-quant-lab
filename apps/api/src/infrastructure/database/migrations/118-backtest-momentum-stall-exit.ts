import type { Migration } from "../migration-runner.js";

/**
 * Widens `backtest_trades.exit_reason` to allow `MOMENTUM_STALL`, a new backtest-only replay of the
 * live evaluator's stall rule (`paper-trading/application/evaluate-open-paper-trades.ts`,
 * `MOMENTUM_STALL_POLICIES`), re-derived for underlying-index bars -- see
 * `apps/api/src/modules/backtesting/domain/momentum-stall-exit.ts`. Measurement only: nothing live
 * reads `backtest_trades`, and this constraint change does not touch `paper_trades`, which has
 * accepted this exit reason since migration 116. Follows the same pattern migration 112 used to add
 * `OPPOSING_LIQUIDITY_SWEEP` to this same table.
 */
export const backtestMomentumStallExitMigration: Migration = {
  id: "118-backtest-momentum-stall-exit",
  sql: `
    ALTER TABLE backtest_trades DROP CONSTRAINT IF EXISTS backtest_trades_exit_reason_check;
    ALTER TABLE backtest_trades ADD CONSTRAINT backtest_trades_exit_reason_check
      CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'SIGNAL', 'END_OF_DATA', 'OPPOSING_LIQUIDITY_SWEEP', 'MOMENTUM_STALL'));
  `,
};
