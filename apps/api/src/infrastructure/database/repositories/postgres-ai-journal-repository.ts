import { hostname } from "node:os";
import type { DatabasePool } from "../database.js";
import type {
  AiBrainThought,
  AiReflectionLog,
} from "../../../modules/strategy-engine/application/ai-autonomous-agent.js";

/** Recorded on each thought so "the agent was silent" and "nothing ticked it" stay distinguishable. */
const PROCESS_IDENTITY = `${hostname()}:${process.pid}`;

export class PostgresAiJournalRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Persists one thought.
   *
   * Thoughts were in-memory only, which stopped working when the agent tick moved from the
   * dashboard's SSE handler to the scheduler: the API process that answers the dashboard no longer
   * produces them. See migration 052.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert. A thought is an observation made at an instant,
   * not a record to be revised, and its id already carries a timestamp -- a colliding id means the
   * same thought is being written twice, and keeping the first is correct.
   */
  public async saveThought(thought: AiBrainThought): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_brain_thoughts (
           id, timestamp, symbol, action, confidence, message, details, recorded_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          thought.id,
          thought.timestamp || new Date().toISOString(),
          thought.symbol,
          thought.action,
          thought.confidence,
          thought.message,
          JSON.stringify(thought.details ?? {}),
          PROCESS_IDENTITY,
        ],
      );
    } finally {
      client.release();
    }
  }

  /** Most recent thoughts first, optionally for one symbol. */
  public async getRecentThoughts(limit: number, symbol?: string): Promise<AiBrainThought[]> {
    const client = await this.pool.connect();
    try {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
      const result = symbol
        ? await client.query(
          `SELECT id, timestamp, symbol, action, confidence, message, details
             FROM ai_brain_thoughts WHERE symbol = $2 ORDER BY timestamp DESC LIMIT $1`,
          [bounded, symbol.toUpperCase()],
        )
        : await client.query(
          `SELECT id, timestamp, symbol, action, confidence, message, details
             FROM ai_brain_thoughts ORDER BY timestamp DESC LIMIT $1`,
          [bounded],
        );
      return result.rows.map((row: Record<string, unknown>): AiBrainThought => ({
        id: String(row.id),
        timestamp: new Date(row.timestamp as string | Date).toISOString(),
        symbol: String(row.symbol),
        action: String(row.action) as AiBrainThought["action"],
        confidence: Number(row.confidence),
        message: String(row.message),
        details: (row.details ?? {}) as Record<string, unknown>,
      }));
    } finally {
      client.release();
    }
  }

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
