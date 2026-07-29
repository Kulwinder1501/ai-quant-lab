import type { Migration } from "../migration-runner.js";

export const aiMemoryAndRagMigration: Migration = {
  id: "005-ai-memory-and-rag",
  sql: `
    CREATE TABLE IF NOT EXISTS ai_journal_reflections (
      id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      instrument_symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      pnl NUMERIC(10, 2) NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS')),
      analysis TEXT NOT NULL,
      improvement_rule TEXT NOT NULL,
      embedding vector(384) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ai_journal_reflections_embedding_idx 
    ON ai_journal_reflections USING hnsw (embedding vector_cosine_ops);

    CREATE TABLE IF NOT EXISTS market_context_embeddings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
      embedding vector(384) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(candle_id)
    );

    CREATE INDEX IF NOT EXISTS market_context_embeddings_embedding_idx 
    ON market_context_embeddings USING hnsw (embedding vector_cosine_ops);
  `,
};
