import type { Migration } from "../migration-runner.js";

/**
 * Widens `paper_trades.exit_reason` to accept the 5 reasons the O1 exit state machine
 * (domain/o1-exit-state-machine.ts, added in migration 121) actually emits: `HARD_STOP`,
 * `UNDERLYING_INVALIDATION`, `TIME_STOP`, `PREMIUM_TOLERANCE`, `TARGET_REACHED`. Migration 121
 * added the O1 engine's supporting columns but never mirrored its exit reasons into this CHECK
 * constraint, so every attempt to close an O1-managed trade failed with
 * `paper_trades_exit_reason_check` and left the position stuck open indefinitely -- the same
 * class of drift migration 116 fixed for `SESSION_CLOSE`.
 */
export const paperTradeO1ExitReasonMigration: Migration = {
  id: "124-paper-trade-o1-exit-reason",
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
        'SESSION_CLOSE',
        'HARD_STOP',
        'UNDERLYING_INVALIDATION',
        'TIME_STOP',
        'PREMIUM_TOLERANCE',
        'TARGET_REACHED'
      ));
  `,
};
