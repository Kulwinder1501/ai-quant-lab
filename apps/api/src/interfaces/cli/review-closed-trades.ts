import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresTradeReviewRepository } from "../../infrastructure/database/repositories/postgres-trade-review-repository.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { buildTradeReview } from "../../modules/paper-trading/domain/trade-review.js";
import { layeredOutcomeFromClosedTrade } from "../../modules/autonomous-v2/application/legacy-trade-outcome-adapter.js";
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
      fees: string | null; underlying_entry_price: string | null; partial_exits: string;
    }>(`
      SELECT paper_trades.id, paper_trades.instrument_id, paper_trades.side, paper_trades.quantity,
             paper_trades.realized_pnl, paper_trades.exit_reason, paper_trades.entry_price,
             paper_trades.exit_price, paper_trades.stop_loss, paper_trades.target_price,
             paper_trades.opened_at, paper_trades.closed_at, source_candle.timeframe,
             paper_trades.fees, paper_trades.underlying_entry_price,
             (SELECT count(*) FROM paper_trade_partial_exits pe
               WHERE pe.paper_trade_id = paper_trades.id) AS partial_exits
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
    /*
     * Brain P11's three-layer reconciliation, run over every trade being reviewed.
     *
     * The review already says whether a trade worked and whether its geometry was right. What it cannot
     * say is which layer a loss came from, and the reconciliation adds the one part of that which the
     * stored data supports today: whether the booked P&L agrees with the recorded fills once fees are
     * accounted for.
     *
     * Measured over 325 closed trades when this was wired in: 325 reconciled, 0 refused, 324 with a
     * residual inside a paisa, and exactly one flagged -- trade 951a0ecb, whose residual is precisely
     * its own fees because it booked P&L gross where every other trade booked it net.
     *
     * The underlying layer is absent, so no attribution is attempted. `paper_trades` has no underlying
     * exit price, and inventing one would let `attributeShortfall` blame the thesis on an inference.
     */
    let residualsChecked = 0;
    let residualsClean = 0;
    const residualFlags: string[] = [];
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
      const adapted = layeredOutcomeFromClosedTrade({
        tradeId: row.id,
        contractSymbol: instrumentSymbols.get(row.instrument_id) ?? "UNKNOWN",
        // Paper option positions are long the contract; migration 023 enforces it.
        side: "LONG",
        quantity: Number(row.quantity),
        entryPrice: Number(row.entry_price),
        exitPrice: Number(row.exit_price),
        realisedPnl: Number(row.realized_pnl ?? 0),
        fees: row.fees === null ? null : Number(row.fees),
        underlyingEntryPrice: row.underlying_entry_price === null ? null : Number(row.underlying_entry_price),
        hasPartialExits: Number(row.partial_exits) > 0,
      });
      residualsChecked += 1;
      // A paisa: the prices carry six decimals, so anything larger is a real disagreement rather than
      // rounding.
      const residualIsClean = Math.abs(adapted.unexplainedResidual) <= 0.01;
      if (residualIsClean) residualsClean += 1;
      else {
        residualFlags.push(
          `${row.id.substring(0, 8)} residual ${adapted.unexplainedResidual.toFixed(2)} `
          + `(fees ${row.fees ?? "null"}, partialExits ${row.partial_exits})`,
        );
      }

      console.log(`${row.id.substring(0, 8)}  ${review.outcome.padEnd(9)} ${String(review.realizedR).padStart(8)}R  `
        + `MFE ${String(review.maximumFavourableExcursionR).padStart(6)}R  MAE ${String(review.maximumAdverseExcursionR).padStart(6)}R  `
        + `${String(review.observedTimeframe).padEnd(4)} x${review.candlesObserved}  `
        + `${residualIsClean ? "reconciled" : "RESIDUAL"}  [${review.proposedResearchTags.join(", ")}]`);
    }

    console.log(`\nreviewed ${trades.rows.length} closed trade(s)`);
    /*
     * Reported as a count rather than only per trade, because the interesting reading is the ratio: a
     * handful of residuals is a data-recording question, and a sudden jump is a pricing regression.
     */
    console.log(`three-layer reconciliation: ${residualsClean}/${residualsChecked} within a paisa`);
    for (const flag of residualFlags) console.log(`  RESIDUAL  ${flag}`);
    if (residualFlags.length > 0) {
      console.log("  A residual is the booked P&L disagreeing with the recorded fills beyond fees. It is a");
      console.log("  finding, not a failure: check whether that trade's P&L was booked gross or net.");
    }
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
