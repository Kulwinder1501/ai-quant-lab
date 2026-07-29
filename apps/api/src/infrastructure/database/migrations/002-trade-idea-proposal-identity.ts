import type { Migration } from "../migration-runner.js";

/**
 * A strategy proposal is deterministic for one completed source candle and side.
 * The nullable predicate leaves room for future, non-strategy trade ideas while
 * making strategy-generated proposals safe to retry.
 */
export const tradeIdeaProposalIdentityMigration: Migration = {
  id: "002-trade-idea-proposal-identity",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS trade_ideas_strategy_candle_side_identity_idx
    ON trade_ideas (strategy_version_id, source_candle_id, side)
    WHERE strategy_version_id IS NOT NULL AND source_candle_id IS NOT NULL;
  `,
};
