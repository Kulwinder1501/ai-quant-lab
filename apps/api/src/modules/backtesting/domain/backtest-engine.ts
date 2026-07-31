import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import { TrendBreakoutStrategy } from "../../strategy-engine/domain/trend-breakout-strategy.js";
import { decidePaperTradeExit } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import type { PaperTrade } from "../../paper-trading/domain/paper-trading.js";
import { calculateBacktestMetrics, calculateMonthlyPerformance, type BacktestCounters } from "./backtest-metrics.js";
import type { BacktestConfiguration, BacktestEvaluationResult, BacktestExitReason, BacktestTrade } from "./backtesting.js";

export const defaultBacktestConfiguration: BacktestConfiguration = {
  quantity: 1,
  initialCapital: 100_000,
  feePerOrder: 0,
  slippageBps: 0,
  // Fixed quantity stays the default so previously recorded runs remain
  // reproducible. Constant-risk sizing has to be asked for.
  positionSizing: "FIXED_QUANTITY",
  riskFractionPerTrade: 0.01,
  marginFraction: 1,
  entryPolicy: "NEXT_CANDLE_OPEN",
  invalidGapPolicy: "SKIP_IF_NEXT_OPEN_IS_NOT_STRICTLY_INSIDE_SOURCE_STOP_TARGET",
  exitPolicy: "GAP_AT_OPEN_THEN_CONSERVATIVE_STOP_FIRST",
  endOfDataExitPolicy: "CLOSE_AT_FINAL_COMPLETED_CANDLE_CLOSE",
  maxConcurrentPositions: 1,
};

interface PendingSignal {
  proposal: ProposedTradeIdea;
  sourceContext: StrategyMarketContext;
}

interface OpenPosition {
  paperTrade: PaperTrade;
  sourceCandleId: string;
  entryCandleId: string;
  entryFees: number;
}

/** Minimal contract needed by the replay engine, kept injectable for deterministic tests. */
export interface BacktestStrategyEvaluator {
  evaluate(context: StrategyMarketContext, strategyConfiguration: Record<string, unknown>): ProposedTradeIdea[];
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function roundDownToTick(value: number, tickSize: number): number {
  return rounded(Math.floor((value + Number.EPSILON) / tickSize) * tickSize);
}

function roundUpToTick(value: number, tickSize: number): number {
  return rounded(Math.ceil((value - Number.EPSILON) / tickSize) * tickSize);
}

function assertConfiguration(configuration: BacktestConfiguration): void {
  if (!Number.isFinite(configuration.quantity) || configuration.quantity <= 0
    || !Number.isFinite(configuration.initialCapital) || configuration.initialCapital <= 0
    || !Number.isFinite(configuration.feePerOrder) || configuration.feePerOrder < 0
    || !Number.isFinite(configuration.slippageBps) || configuration.slippageBps < 0 || configuration.slippageBps >= 10_000
    || (configuration.positionSizing !== "FIXED_QUANTITY" && configuration.positionSizing !== "CONSTANT_RISK_FRACTION")
    || !Number.isFinite(configuration.riskFractionPerTrade)
    || configuration.riskFractionPerTrade <= 0 || configuration.riskFractionPerTrade > 1
    || !Number.isFinite(configuration.marginFraction)
    || configuration.marginFraction <= 0 || configuration.marginFraction > 1
    || configuration.entryPolicy !== "NEXT_CANDLE_OPEN"
    || configuration.invalidGapPolicy !== "SKIP_IF_NEXT_OPEN_IS_NOT_STRICTLY_INSIDE_SOURCE_STOP_TARGET"
    || configuration.exitPolicy !== "GAP_AT_OPEN_THEN_CONSERVATIVE_STOP_FIRST"
    || configuration.endOfDataExitPolicy !== "CLOSE_AT_FINAL_COMPLETED_CANDLE_CLOSE"
    || configuration.maxConcurrentPositions !== 1) {
    throw new Error("Backtest configuration is invalid.");
  }
}

function assertChronological(contexts: readonly StrategyMarketContext[]): void {
  const first = contexts[0];
  if (!first) return;
  const instrumentId = first.candle.instrumentId;
  const timeframe = first.candle.timeframe;
  for (let index = 0; index < contexts.length; index += 1) {
    const candle = contexts[index].candle;
    const prices = [candle.open, candle.high, candle.low, candle.close, candle.volume, candle.tickSize];
    if (!candle.instrumentId.trim() || !candle.timeframe.trim()
      || !(candle.openTime instanceof Date) || Number.isNaN(candle.openTime.getTime())
      || !(candle.closeTime instanceof Date) || Number.isNaN(candle.closeTime.getTime())
      || candle.closeTime.getTime() <= candle.openTime.getTime()
      || prices.some((value) => !Number.isFinite(value))
      || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0
      || candle.volume < 0 || candle.tickSize <= 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.low > candle.high) {
      throw new Error("Backtest contexts contain an invalid completed candle.");
    }
    if (candle.instrumentId !== instrumentId || candle.timeframe !== timeframe) {
      throw new Error("A backtest run can replay only one instrument and timeframe.");
    }
    if (index === 0) continue;
    const previous = contexts[index - 1].candle;
    if (candle.openTime.getTime() <= previous.openTime.getTime()) {
      throw new Error("Backtest contexts must be strictly chronological.");
    }
    if (candle.openTime.getTime() < previous.closeTime.getTime()) {
      throw new Error("Backtest contexts must not overlap in time.");
    }
  }
}

function isFillInsideRiskGeometry(proposal: ProposedTradeIdea, fillPrice: number): boolean {
  return proposal.side === "LONG"
    ? proposal.stopLoss < fillPrice && fillPrice < proposal.targetPrice
    : proposal.targetPrice < fillPrice && fillPrice < proposal.stopLoss;
}

function assertProposal(proposal: ProposedTradeIdea): void {
  const values = [proposal.entryPrice, proposal.stopLoss, proposal.targetPrice, proposal.riskReward, proposal.confidence];
  if ((proposal.side !== "LONG" && proposal.side !== "SHORT")
    || values.some((value) => !Number.isFinite(value))
    || proposal.entryPrice <= 0 || proposal.stopLoss <= 0 || proposal.targetPrice <= 0
    || proposal.riskReward <= 0 || proposal.confidence < 0 || proposal.confidence > 1
    || !isFillInsideRiskGeometry(proposal, proposal.entryPrice)) {
    throw new Error("Strategy returned a proposal with invalid risk geometry.");
  }
}

function entryFillPrice(side: PaperTrade["side"], open: number, slippageBps: number, tickSize: number): number {
  const multiplier = slippageBps / 10_000;
  const slipped = side === "LONG" ? open * (1 + multiplier) : open * (1 - multiplier);
  return side === "LONG" ? roundUpToTick(slipped, tickSize) : roundDownToTick(slipped, tickSize);
}

function exitFillPrice(side: PaperTrade["side"], rawExit: number, slippageBps: number, tickSize: number): number {
  const multiplier = slippageBps / 10_000;
  const slipped = side === "LONG" ? rawExit * (1 - multiplier) : rawExit * (1 + multiplier);
  return side === "LONG" ? roundDownToTick(slipped, tickSize) : roundUpToTick(slipped, tickSize);
}

/**
 * Units to fill, or null when the risk budget cannot buy a whole unit.
 *
 * Under constant-risk sizing the quantity falls as the stop widens, so the
 * capital at risk is the same on every trade and a wide-stop trade can no longer
 * outweigh several narrow-stop ones. Rounding is downward so the realised risk
 * never exceeds the configured budget.
 */
function resolveQuantity(
  proposal: ProposedTradeIdea,
  fillPrice: number,
  configuration: BacktestConfiguration,
): number | null {
  if (configuration.positionSizing === "FIXED_QUANTITY") return configuration.quantity;
  const riskPerUnit = Math.abs(fillPrice - proposal.stopLoss);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;
  const riskBudget = configuration.initialCapital * configuration.riskFractionPerTrade;
  const quantity = Math.floor(riskBudget / riskPerUnit);
  return quantity >= 1 ? quantity : null;
}

type PositionAttempt = OpenPosition | "INVALID_GAP" | "UNSIZABLE";

function createPosition(
  pending: PendingSignal,
  entryContext: StrategyMarketContext,
  configuration: BacktestConfiguration,
): PositionAttempt {
  const { proposal } = pending;
  const rawOpen = entryContext.candle.open;
  if (!isFillInsideRiskGeometry(proposal, rawOpen)) return "INVALID_GAP";
  const fillPrice = entryFillPrice(proposal.side, rawOpen, configuration.slippageBps, entryContext.candle.tickSize);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !isFillInsideRiskGeometry(proposal, fillPrice)) return "INVALID_GAP";
  const quantity = resolveQuantity(proposal, fillPrice, configuration);
  if (quantity === null) return "UNSIZABLE";
  const paperTrade: PaperTrade = {
    id: `backtest-${pending.sourceContext.candle.id}`,
    accountId: "backtest",
    tradeIdeaId: null,
    instrumentId: entryContext.candle.instrumentId,
    timeframe: entryContext.candle.timeframe,
    side: proposal.side,
    status: "OPEN",
    quantity,
    entryPrice: fillPrice,
    stopLoss: proposal.stopLoss,
    targetPrice: proposal.targetPrice,
    openedAt: entryContext.candle.openTime,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    fees: configuration.feePerOrder,
    slippage: 0,
    notes: "Historical backtest position",
  };
  return {
    paperTrade,
    sourceCandleId: pending.sourceContext.candle.id,
    entryCandleId: entryContext.candle.id,
    entryFees: configuration.feePerOrder,
  };
}

function closePosition(input: {
  position: OpenPosition;
  exitContext: StrategyMarketContext;
  rawExitPrice: number;
  exitReason: BacktestExitReason;
  exitTime: Date;
  fillRule: string;
  configuration: BacktestConfiguration;
}): BacktestTrade {
  const tickSize = input.exitContext.candle.tickSize;
  const exitPrice = exitFillPrice(input.position.paperTrade.side, input.rawExitPrice, input.configuration.slippageBps, tickSize);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error("Backtest exit fill price is invalid after adverse slippage and tick rounding.");
  }
  const entryPrice = input.position.paperTrade.entryPrice;
  const quantity = input.position.paperTrade.quantity;
  const grossPnl = input.position.paperTrade.side === "LONG"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const totalFees = input.position.entryFees + input.configuration.feePerOrder;
  const pnl = rounded(grossPnl - totalFees);
  return {
    instrumentId: input.position.paperTrade.instrumentId,
    side: input.position.paperTrade.side,
    entryTime: input.position.paperTrade.openedAt,
    exitTime: input.exitTime,
    entryPrice,
    exitPrice,
    quantity,
    pnl,
    returnPercent: rounded(pnl / (entryPrice * quantity) * 100),
    exitReason: input.exitReason,
    reasoning: [
      `Signal source candle: ${input.position.sourceCandleId}.`,
      "Entry policy: next eligible candle open, adjusted adversely for configured slippage.",
      `Entry candle: ${input.position.entryCandleId}; exit candle: ${input.exitContext.candle.id}.`,
      `Exit policy: ${input.fillRule}.`,
      input.configuration.positionSizing === "FIXED_QUANTITY"
        ? `Sizing: FIXED_QUANTITY at ${quantity} unit(s).`
        : `Sizing: CONSTANT_RISK_FRACTION at ${(input.configuration.riskFractionPerTrade * 100).toFixed(4)}% of ${input.configuration.initialCapital} initial capital, giving ${quantity} unit(s).`,
      `Configured costs: ${input.configuration.feePerOrder.toFixed(6)} INR per order and ${input.configuration.slippageBps.toFixed(4)} bps slippage.`,
    ],
  };
}

function proposalFor(context: StrategyMarketContext, strategy: BacktestStrategyEvaluator, strategyConfiguration: Record<string, unknown>): ProposedTradeIdea | null {
  const proposal = strategy.evaluate(context, strategyConfiguration)[0] ?? null;
  if (proposal) assertProposal(proposal);
  return proposal;
}

/**
 * Replays one instrument flat-to-flat. Signals become known at candle close and
 * are filled only at the next candle open; at most one position may be open.
 */
export class BacktestEngine {
  constructor(private readonly strategy: BacktestStrategyEvaluator = new TrendBreakoutStrategy()) {}

  run(
    contexts: readonly StrategyMarketContext[],
    strategyConfiguration: Record<string, unknown>,
    configuration: BacktestConfiguration = defaultBacktestConfiguration,
  ): BacktestEvaluationResult {
    assertConfiguration(configuration);
    assertChronological(contexts);
    const counters: BacktestCounters = {
      signalCount: 0,
      skippedSignalsNoNextCandle: 0,
      skippedSignalsWhilePositionOpen: 0,
      skippedSignalsInvalidGap: 0,
      skippedSignalsInsufficientCapital: 0,
      skippedSignalsUnsizable: 0,
    };
    const trades: BacktestTrade[] = [];
    let realisedEquity = configuration.initialCapital;
    let pending: PendingSignal | null = null;
    let position: OpenPosition | null = null;

    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      if (pending) {
        const candidate = createPosition(pending, context, configuration);
        pending = null;
        if (candidate === "INVALID_GAP") {
          counters.skippedSignalsInvalidGap += 1;
        } else if (candidate === "UNSIZABLE") {
          counters.skippedSignalsUnsizable += 1;
        } else if (
          candidate.paperTrade.entryPrice * candidate.paperTrade.quantity * configuration.marginFraction
            + candidate.entryFees > realisedEquity + 1e-9
        ) {
          counters.skippedSignalsInsufficientCapital += 1;
        } else {
          position = candidate;
        }
      }

      if (position) {
        const decision = decidePaperTradeExit(position.paperTrade, context.candle);
        if (decision) {
          const exitTime = decision.fillRule.startsWith("OPEN_GAP") ? context.candle.openTime : context.candle.closeTime;
          const trade = closePosition({
            position,
            exitContext: context,
            rawExitPrice: decision.exitPrice,
            exitReason: decision.reason,
            exitTime,
            fillRule: decision.fillRule,
            configuration,
          });
          trades.push(trade);
          realisedEquity += trade.pnl;
          position = null;
        }
      }

      const proposal = proposalFor(context, this.strategy, strategyConfiguration);
      if (!proposal) continue;
      counters.signalCount += 1;
      if (position || pending) {
        counters.skippedSignalsWhilePositionOpen += 1;
      } else if (index === contexts.length - 1) {
        counters.skippedSignalsNoNextCandle += 1;
      } else {
        pending = { proposal, sourceContext: context };
      }
    }

    if (position && contexts.length > 0) {
      const lastContext = contexts[contexts.length - 1];
      const trade = closePosition({
        position,
        exitContext: lastContext,
        rawExitPrice: lastContext.candle.close,
        exitReason: "END_OF_DATA",
        exitTime: lastContext.candle.closeTime,
        fillRule: "END_OF_DATA_CLOSE",
        configuration,
      });
      trades.push(trade);
      realisedEquity += trade.pnl;
    }

    return {
      trades,
      monthlyPerformance: calculateMonthlyPerformance(trades, configuration.initialCapital),
      metrics: calculateBacktestMetrics(trades, configuration.initialCapital, counters),
    };
  }
}
