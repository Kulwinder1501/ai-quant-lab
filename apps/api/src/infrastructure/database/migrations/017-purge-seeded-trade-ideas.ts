import type { Migration } from "../migration-runner.js";

/**
 * Deletes fabricated trade-idea rows left by the market/scalp seeds.
 *
 * Two seed paths wrote demo proposals into the same `trade_ideas` table the real
 * strategy engine uses:
 *
 * * `seed-market-data` inserted a LONG from the latest close with a hard-coded
 *   1.5%/3% geometry and the reasoning
 *   "Seeded breakout momentum proposal ready for paper simulation".
 * * `seed-scalp-data` inserted BOTH a LONG and a SHORT from the same close, with
 *   ±0.1%/±0.2% fabricated geometry and `evidence.seeded = true`. That pair is
 *   physically impossible under MomentumScalpStrategy (LONG needs price above VWAP
 *   with fast EMA above slow; SHORT needs the opposite), but the unique key
 *   `(strategy_version_id, source_candle_id, side)` allowed both rows to coexist.
 *   The Strategy dashboard then showed a LONG and a SHORT sharing one entry price
 *   and one candle close time as if the engine had produced both.
 *
 * Matching either the seeded evidence flag or the seeded reasoning text catches
 * both generators. Paper trades that referenced a deleted idea keep their row —
 * `paper_trades.trade_idea_id` is ON DELETE SET NULL — so measured history is not
 * rewritten. Evidence child rows cascade.
 *
 * Re-running the seeds after this migration no longer recreates these rows.
 */
export const purgeSeededTradeIdeasMigration: Migration = {
  id: "017-purge-seeded-trade-ideas",
  sql: `
    DELETE FROM trade_ideas
    WHERE evidence->>'seeded' = 'true'
       OR reasoning::text ILIKE '%Seeded%'
  `,
};
