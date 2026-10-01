import type { Migration } from "../migration-runner.js";

/**
 * Widens `backtest_trades.exit_reason` to allow `OPPOSING_LIQUIDITY_SWEEP`, a new backtest-only
 * early-exit reason (close an open position the bar an SMC `LIQUIDITY_SWEEP` against its own side
 * is detected, instead of waiting for the stop). Measurement only -- see
 * `apps/api/src/modules/backtesting/domain/opposing-sweep-exit.ts`; nothing live reads this.
 */
export const backtestOpposingSweepExitMigration: Migration = {
  id: "112-backtest-opposing-sweep-exit",
  sql: `
    ALTER TABLE backtest_trades DROP CONSTRAINT backtest_trades_exit_reason_check;
    ALTER TABLE backtest_trades ADD CONSTRAINT backtest_trades_exit_reason_check
      CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'SIGNAL', 'END_OF_DATA', 'OPPOSING_LIQUIDITY_SWEEP'));
  `,
};
