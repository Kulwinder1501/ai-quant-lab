import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresTradeReviewRepository } from "../../infrastructure/database/repositories/postgres-trade-review-repository.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { buildTradeReview } from "../../modules/paper-trading/domain/trade-review.js";
import { layeredOutcomeFromClosedTrade } from "../../modules/autonomous-v2/application/legacy-trade-outcome-adapter.js";
import { attributeShortfall } from "../../modules/autonomous-v2/domain/outcome-layers.js";
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
      underlying_exit_price: string | null; idea_side: TradeSide | null;
      idea_stop: string | null; idea_target: string | null;
    }>(`
      SELECT paper_trades.id, paper_trades.instrument_id, paper_trades.side, paper_trades.quantity,
             paper_trades.realized_pnl, paper_trades.exit_reason, paper_trades.entry_price,
             paper_trades.exit_price, paper_trades.stop_loss, paper_trades.target_price,
             paper_trades.opened_at, paper_trades.closed_at, source_candle.timeframe,
             paper_trades.fees, paper_trades.underlying_entry_price,
             paper_trades.underlying_exit_price,
             -- The thesis levels are the *underlying's*, and they live on the idea rather than on the
             -- trade, whose stop and target are option premiums. Needed to say whether the thesis
             -- resolved, which is a different question from whether the option's barrier was hit.
             trade_ideas.side AS idea_side, trade_ideas.stop_loss AS idea_stop,
             trade_ideas.target_price AS idea_target,
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
     * its own fees because its `realized_pnl` is gross where every other trade's is net.
     *
     * That one flag has since been run down and is not a code defect: both close paths have shared one
     * expression since `fe84dc6`, and that trade was closed by a hand-written `UPDATE`. So a *steady*
     * count of one is the expected output here, and it is the count rising that means something. See
     * migration 088.
     *
     */
    let residualsChecked = 0;
    let residualsClean = 0;
    const residualFlags: string[] = [];
    /*
     * Migration 089 makes the underlying layer constructible, so the review can finally report which
     * layer a loss came from. Counted by bucket rather than only per trade: the interesting reading
     * is the mix, and a sudden swing towards EXECUTION is the shape the three exit defects had.
     *
     * `unattributed` is expected to dominate for a long while -- every trade closed before 089 has no
     * underlying exit level and every non-tick close still has none, so those decline by design.
     */
    const attribution = { UNDERLYING: 0, INSTRUMENT: 0, EXECUTION: 0, unattributed: 0 };
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
        underlyingExitPrice: row.underlying_exit_price === null ? null : Number(row.underlying_exit_price),
        underlyingThesis: row.idea_side === null || row.idea_stop === null || row.idea_target === null
          ? null
          : { direction: row.idea_side, stop: Number(row.idea_stop), target: Number(row.idea_target) },
        hasPartialExits: Number(row.partial_exits) > 0,
      });
      /*
       * Endpoint attribution. `attributeShortfall` returns null for a profitable trade and whenever
       * the layers do not single one out, so `unattributed` mixes "nothing to explain" with "cannot
       * tell" -- it is a floor on unexplained losses, not a count of them.
       */
      const blamed = attributeShortfall(adapted.outcome);
      attribution[blamed ?? "unattributed"] += 1;
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
    console.log(
      `shortfall attribution: UNDERLYING ${attribution.UNDERLYING}  INSTRUMENT ${attribution.INSTRUMENT}  `
      + `EXECUTION ${attribution.EXECUTION}  unattributed ${attribution.unattributed}`,
    );
    if (attribution.unattributed === residualsChecked && residualsChecked > 0) {
      console.log("  Nothing attributed: no reviewed trade carries an observed underlying exit level.");
      console.log("  Expected until trades close under migration 089 via the observed-tick path.");
    }
    for (const flag of residualFlags) console.log(`  RESIDUAL  ${flag}`);
    if (residualFlags.length > 0) {
      console.log("  A residual is the booked P&L disagreeing with the recorded fills beyond fees. It is a");
      console.log("  finding, not a failure. One known residual is expected: trade 951a0ecb, closed by hand");
      console.log("  and therefore gross. For any other, check for a close that bypassed the application -- no");
      console.log("  close event, no slice row, remaining_quantity not decremented. See migration 088.");
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
