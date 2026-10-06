import type { Migration } from "../migration-runner.js";

/**
 * Widens `paper_trades.exit_reason` to accept `SESSION_CLOSE`. The 15:15 IST flatten added to
 * `PaperTradeExitReason` in domain/paper-trading.ts (see domain/session-close.ts) was never
 * mirrored into this CHECK constraint, so every attempt to square off a position at the session
 * boundary failed with `paper_trades_exit_reason_check` and left the trade's stop/target
 * un-enforced. Mirrors migration 115's currency widening for the same class of drift.
 */
export const paperTradeSessionCloseExitReasonMigration: Migration = {
  id: "116-paper-trade-session-close-exit-reason",
  sql: `
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_exit_reason_check
      CHECK (exit_reason IN (
        'STOP_LOSS',
        'TARGET',
        'MANUAL',
        'CANCELLED',
        'EXPIRED',
        'TRAP_DETECTED',
        'T1_TARGET',
        'T2_TARGET',
        'RUNNER_TRAIL',
        'MOMENTUM_STALL',
        'SESSION_CLOSE'
      ));
  `,
};
