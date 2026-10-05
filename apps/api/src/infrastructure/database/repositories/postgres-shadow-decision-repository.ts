import type { DatabaseQueryable } from "../database.js";

export interface ShadowDecisionInput {
  readonly accountId: string;
  readonly strategyKey: string;
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly sourceCandleId: string;
  readonly evaluatedAt: Date;
  readonly proposalCount: number;
  readonly decision: "EXECUTED" | "REFUSED" | "NO_SIGNAL";
  readonly contextMetadata: Record<string, unknown>;
  readonly strategyMetadata: Record<string, unknown>;
}

/**
 * Writer and reader for `shadow_decisions` (migration 123) -- the G2 persistence path
 * `audit-gold-shadow-failures.ts` has always queried but, until this, had nowhere to read from.
 */
export class PostgresShadowDecisionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Records one strategy's evaluation of one bar for one account.
   *
   * Idempotent on `(account_id, strategy_key, source_candle_id)` -- `generate-trade-ideas.ts`
   * re-evaluates the latest completed candle on every scheduler tick, and the bar does not change
   * again until the next one closes, so a second write for the same bar is expected and must be a
   * no-op rather than a duplicate row. Returns whether a row was newly written.
   */
  async recordDecision(input: ShadowDecisionInput): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO shadow_decisions (
        account_id, strategy_key, instrument_id, timeframe, source_candle_id,
        evaluated_at, proposal_count, decision, context_metadata, strategy_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (account_id, strategy_key, source_candle_id) DO NOTHING
      RETURNING id
    `, [
      input.accountId, input.strategyKey, input.instrumentId, input.timeframe, input.sourceCandleId,
      input.evaluatedAt, input.proposalCount, input.decision,
      JSON.stringify(input.contextMetadata), JSON.stringify(input.strategyMetadata),
    ]);
    return result.rows.length > 0;
  }
}
