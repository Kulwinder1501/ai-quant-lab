import type { Migration } from "../migration-runner.js";

// Removes the pseudo-embeddings, which were noise presented as semantic memory.
//
// `generatePseudoEmbedding` built a 384-d vector as
// `Math.sin(hash + i) * Math.cos(hash * i)` from a string hash. That is a
// deterministic function of the text with no semantic structure whatsoever:
// two near-identical descriptions hash to unrelated points, so cosine distance
// over these vectors ranks nothing meaningful. Every row written with it is
// unusable, and leaving those rows in place would be worse than deleting them —
// once real embeddings exist, a nearest-neighbour query would silently rank real
// vectors against noise in the same index and there would be no way to tell the
// two apart.
//
// `market_context_embeddings` rows are dropped outright rather than blanked. The
// table holds nothing but the vector, so a row with no embedding carries no
// information. The rows were also seeded from a *fabricated* RSI
// (`Math.floor(40 + Math.random() * 30)`), so even the text they described was
// not real market context.
//
// `ai_journal_reflections` rows are kept and only their vector cleared: the
// analysis, improvement rule, outcome, and P/L on those rows are genuine, and
// only the embedding column was fake.
//
// Both columns become nullable so a reflection can be journaled honestly while
// no embedding model exists. NULL here means "not embedded", which is a true
// statement; a fabricated vector was not.
export const removePseudoEmbeddingsMigration: Migration = {
  id: "012-remove-pseudo-embeddings",
  sql: `
    ALTER TABLE ai_journal_reflections ALTER COLUMN embedding DROP NOT NULL;
    ALTER TABLE market_context_embeddings ALTER COLUMN embedding DROP NOT NULL;

    UPDATE ai_journal_reflections SET embedding = NULL;
    DELETE FROM market_context_embeddings;
  `,
};
