import type { DatabasePool } from "../database.js";
import type { AiReflectionLog } from "../../../modules/strategy-engine/application/ai-autonomous-agent.js";

export class PostgresAiJournalRepository {
  constructor(private readonly pool: DatabasePool) {}

  public async saveReflection(reflection: AiReflectionLog, embedding: number[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_journal_reflections (
          id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, embedding, timestamp
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10
        )
        ON CONFLICT (id) DO UPDATE SET
          analysis = EXCLUDED.analysis,
          improvement_rule = EXCLUDED.improvement_rule,
          embedding = EXCLUDED.embedding
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
          `[${embedding.join(",")}]`,
          reflection.timestamp || new Date().toISOString(),
        ]
      );
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

  public async findSimilarLessons(queryEmbedding: number[], limit: number = 3): Promise<AiReflectionLog[]> {
    const client = await this.pool.connect();
    try {
      // Use pgvector cosine distance (<=>)
      const res = await client.query(
        `SELECT id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, timestamp
         FROM ai_journal_reflections
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [`[${queryEmbedding.join(",")}]`, limit]
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
}
