import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresTradeReviewRepository } from "../../infrastructure/database/repositories/postgres-trade-review-repository.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { buildTradeReview } from "../../modules/paper-trading/domain/trade-review.js";
import type { TradeSide } from "../../modules/strategy-engine/domain/strategy.js";

/**
 * Builds a trade review for every closed paper trade.
 *
 * The agent reviews a trade as it closes; this backfills the ones that closed before
 * reviews existed, and is the way to re-derive them after a change to the review logic.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const client = await database.connect();
  try {
    const trades = await client.query<{
      id: string; instrument_id: string; side: TradeSide; quantity: string;
      realized_pnl: string; exit_reason: string | null; entry_price: string;
      exit_price: string; stop_loss: string; target_price: string;
      opened_at: Date; closed_at: Date; timeframe: string | null;
    }>(`
      SELECT paper_trades.id, paper_trades.instrument_id, paper_trades.side, paper_trades.quantity,
             paper_trades.realized_pnl, paper_trades.exit_reason, paper_trades.entry_price,
             paper_trades.exit_price, paper_trades.stop_loss, paper_trades.target_price,
             paper_trades.opened_at, paper_trades.closed_at, source_candle.timeframe
      FROM paper_trades
      LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
      LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
      WHERE paper_trades.status = 'CLOSED' AND paper_trades.closed_at IS NOT NULL
        AND paper_trades.exit_price IS NOT NULL
      ORDER BY paper_trades.closed_at ASC
    `);

    const symbolRows = await client.query<{ id: string; symbol: string }>("SELECT id, symbol FROM instruments");
    const instrumentSymbols = new Map(symbolRows.rows.map((row) => [row.id, row.symbol]));

    const repository = new PostgresTradeReviewRepository(client);
    const journal = new PostgresAiJournalRepository(database);
    for (const row of trades.rows) {
      const holdingPeriod = await repository.findHoldingPeriodCandles({
        instrumentId: row.instrument_id,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        preferredTimeframe: row.timeframe,
      });
      const review = buildTradeReview({
        tradeId: row.id,
        side: row.side,
        quantity: Number(row.quantity),
        entryPrice: Number(row.entry_price),
        exitPrice: Number(row.exit_price),
        stopLoss: Number(row.stop_loss),
        targetPrice: Number(row.target_price),
        realizedPnl: Number(row.realized_pnl ?? 0),
        exitReason: row.exit_reason,
        candles: holdingPeriod.candles,
        observedTimeframe: holdingPeriod.timeframe,
      });
      await repository.save(review);

      // The journal is what the dashboard reads, so it is rewritten from the measured
      // review. Left alone, its templated text would keep asserting that every one of
      // these trades "hit Target Profit", including the manual closes.
      await journal.deleteByTradeId(row.id);
      await journal.saveReflection({
        id: `ref-${row.id}`,
        timestamp: row.closed_at.toISOString(),
        tradeId: row.id,
        symbol: instrumentSymbols.get(row.instrument_id) ?? "UNKNOWN",
        side: row.side,
        pnl: Number(row.realized_pnl ?? 0),
        outcome: review.outcome === "LOSS" ? "LOSS" : "WIN",
        analysis: review.observations.join(" "),
        improvementRule: review.proposedResearchTags.length > 0
          ? `RESEARCH TAGS (aggregate before acting; these change nothing on their own): ${review.proposedResearchTags.join(", ")}.`
          : "No research tag triggered: geometry and outcome were unremarkable.",
      });
      console.log(`${row.id.substring(0, 8)}  ${review.outcome.padEnd(9)} ${String(review.realizedR).padStart(8)}R  `
        + `MFE ${String(review.maximumFavourableExcursionR).padStart(6)}R  MAE ${String(review.maximumAdverseExcursionR).padStart(6)}R  `
        + `${String(review.observedTimeframe).padEnd(4)} x${review.candlesObserved}  [${review.proposedResearchTags.join(", ")}]`);
    }

    console.log(`\nreviewed ${trades.rows.length} closed trade(s)`);
    for (const { tag, tradeCount } of await repository.countResearchTags()) {
      console.log(`  ${tag}: ${tradeCount}`);
    }
  } finally {
    client.release();
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
