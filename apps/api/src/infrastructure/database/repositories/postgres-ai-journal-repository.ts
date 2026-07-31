import type { DatabasePool } from "../database.js";
import type { AiReflectionLog } from "../../../modules/strategy-engine/application/ai-autonomous-agent.js";

export class PostgresAiJournalRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Saves a reflection with no embedding.
   *
   * `embedding` is left NULL rather than accepting a vector, because the only
   * vector this system could previously supply was a string hash. NULL states
   * truthfully that the row has not been embedded.
   */
  public async saveReflection(reflection: AiReflectionLog): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_journal_reflections (
          id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, timestamp
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
        ON CONFLICT (id) DO UPDATE SET
          analysis = EXCLUDED.analysis,
          improvement_rule = EXCLUDED.improvement_rule
        `,
        [
          reflection.id,
          reflection.tradeId,
          reflection.symbol,
          reflection.side,
          reflection.pnl,
          reflection.outcome,
          reflection.analysis,
          reflection.improvementRule,
          reflection.timestamp || new Date().toISOString(),
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Removes any reflection already held for a trade.
   *
   * Reflection ids used to be `ref-<timestamp>-<random>`, so re-reviewing a trade
   * could not overwrite its earlier entry and the superseded text stayed on the
   * dashboard. Deleting by trade id rather than matching on the old wording is
   * deliberate: a text signature would be a heuristic, and this is exact.
   */
  public async deleteByTradeId(tradeId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("DELETE FROM ai_journal_reflections WHERE trade_id = $1", [tradeId]);
    } finally {
      client.release();
    }
  }

  public async getRecentReflections(limit: number): Promise<AiReflectionLog[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, timestamp
         FROM ai_journal_reflections
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );
      
      return res.rows.map((row: any) => ({
        id: row.id,
        timestamp: new Date(row.timestamp).toISOString(),
        tradeId: row.trade_id,
        symbol: row.instrument_symbol,
        side: row.side as "LONG" | "SHORT",
        pnl: Number(row.pnl),
        outcome: row.outcome as "WIN" | "LOSS",
        analysis: row.analysis,
        improvementRule: row.improvement_rule,
      }));
    } finally {
      client.release();
    }
  }

  // `findSimilarLessons` was removed with the pseudo-embeddings. It ordered by
  // cosine distance over hash noise, so it returned an arbitrary fixed set rather
  // than similar lessons. Reinstating semantic retrieval needs a real embedding
  // model and a point-in-time filter (a lesson must not be retrievable by a
  // decision that predates it), so it is better rewritten against that design than
  // kept as a method that looks functional and cannot be.
}
