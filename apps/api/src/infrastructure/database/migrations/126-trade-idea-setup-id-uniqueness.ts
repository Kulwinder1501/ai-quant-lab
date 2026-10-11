import type { Migration } from "../migration-runner.js";

/**
 * Partial Unique Expression Index on `trade_ideas.evidence->>'setupId'` (scoped to status = 'PROPOSED')
 * and system-wide stale PROPOSED trade idea cleanup.
 *
 * System-wide invariant:
 * - NO VALID SETUP / GATE VETO: 0 persisted authorizations.
 * - VALID SETUP: <= 1 persisted PROPOSED authorization per (strategy_version_id, setupId).
 * - CONCURRENT DUPLICATES: Exactly 1 successful insert.
 * - AFTER RESOLUTION: A new attempt at the same setupId is permitted once the prior row exits PROPOSED.
 */
export const tradeIdeaSetupIdUniquenessMigration: Migration = {
  id: "126-trade-idea-setup-id-uniqueness",
  sql: `
    -- Step 1: System-wide cleanup of stale PROPOSED trade ideas across all strategies
    UPDATE trade_ideas
    SET status = 'EXPIRED'
    WHERE status = 'PROPOSED' AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP;

    -- Step 2: Create partial unique expression index scoped to active PROPOSED setups
    CREATE UNIQUE INDEX IF NOT EXISTS trade_ideas_strategy_setup_id_idx
      ON trade_ideas (strategy_version_id, (evidence->>'setupId'))
      WHERE evidence->>'setupId' IS NOT NULL AND status = 'PROPOSED';
  `,
};
