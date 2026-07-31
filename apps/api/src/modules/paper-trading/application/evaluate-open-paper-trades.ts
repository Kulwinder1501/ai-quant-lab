import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { decidePaperTradeExit, type CompletedPriceCandle } from "../domain/paper-trade-exit-policy.js";
import type { PaperTradeRepository } from "../domain/paper-trading.js";
import { calculateExitFees } from "../domain/brokerage-calculator.js";

export interface EvaluateOpenPaperTradesInput {
  accountId: string;
  asOf?: Date;
  exitFees?: number;
  exitSlippage?: number;
  livePrices?: Record<string, number>;
}

export interface EvaluateOpenPaperTradesResult {
  openTradesRead: number;
  pendingTradesRead: number;
  eligibleCandlesRead: number;
  tradesClosed: number;
  closedTradeIds: string[];
  pendingTradesFilled: number;
  filledTradeIds: string[];
  pendingTradesCancelled: number;
  cancelledTradeIds: string[];
  skippedWithoutTimeframe: number;
}

function decimalToNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Persisted candle has invalid ${field}.`);
  }
  return parsed;
}

function toCompletedPriceCandle(candle: PersistedCandle): CompletedPriceCandle {
  const open = decimalToNumber(candle.open, "open");
  const high = decimalToNumber(candle.high, "high");
  const low = decimalToNumber(candle.low, "low");
  const close = decimalToNumber(candle.close, "close");
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new Error("Persisted candle has invalid OHLC geometry.");
  }
  return { id: candle.id, openTime: candle.openTime, closeTime: candle.closeTime, open, high, low, close };
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number.`);
  }
  return value;
}

/** Applies the documented exit policy to closed candles that began after a simulated fill. */
export class EvaluateOpenPaperTrades {
  constructor(
    private readonly paperTradeRepository: PaperTradeRepository,
    private readonly candleRepository: CandleRepository,
  ) {}

  async execute(input: EvaluateOpenPaperTradesInput): Promise<EvaluateOpenPaperTradesResult> {
    const asOf = input.asOf ?? new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw new Error("As-of timestamp is invalid.");
    }
    const explicitExitFees = input.exitFees;
    const exitSlippage = nonNegativeFinite(input.exitSlippage ?? 0, "Exit slippage");
    if (explicitExitFees !== undefined) {
      nonNegativeFinite(explicitExitFees, "Exit fees");
    }
    const openTrades = await this.paperTradeRepository.listOpenByAccount(input.accountId);
    const pendingTrades = await this.paperTradeRepository.listPendingByAccount(input.accountId);
    let eligibleCandlesRead = 0;
    let skippedWithoutTimeframe = 0;
    const closedTradeIds: string[] = [];
    const filledTradeIds: string[] = [];
    const cancelledTradeIds: string[] = [];

    // Evaluate PENDING trades first
    for (const trade of pendingTrades) {
      const tradeDateStr = trade.openedAt.toISOString().split("T")[0];
      const asOfDateStr = asOf.toISOString().split("T")[0];
      if (tradeDateStr !== asOfDateStr) {
        await this.paperTradeRepository.close({
          paperTradeId: trade.id,
          exitPrice: trade.entryPrice,
          exitReason: "CANCELLED",
          closedAt: asOf,
          exitFees: 0,
          exitSlippage: 0,
          details: { reason: "END_OF_DAY_EXPIRATION" },
        });
        cancelledTradeIds.push(trade.id);
        continue;
      }

      let isFilled = false;
      
      const symKey = trade.instrumentSymbol ? trade.instrumentSymbol.toUpperCase() : "";
      const livePrice = input.livePrices?.[symKey] ?? input.livePrices?.[trade.instrumentId];
      if (livePrice !== undefined && Number.isFinite(livePrice) && livePrice > 0) {
        // Trigger based on live price
        if (trade.side === "LONG" && livePrice >= trade.entryPrice) {
          isFilled = true;
        } else if (trade.side === "SHORT" && livePrice <= trade.entryPrice) {
          isFilled = true;
        }
        
        if (isFilled) {
          await this.paperTradeRepository.fillPendingTrade({
            paperTradeId: trade.id,
            fillPrice: trade.entryPrice,
            filledAt: asOf
          });
          filledTradeIds.push(trade.id);
          continue;
        }
      }

      if (!trade.timeframe) continue;
      
      const candles = await this.candleRepository.listCompleted(trade.instrumentId, trade.timeframe);
      for (const persisted of candles) {
        const candle = toCompletedPriceCandle(persisted);
        if (candle.openTime < trade.openedAt || candle.closeTime > asOf) continue;
        
        if (candle.low <= trade.entryPrice && candle.high >= trade.entryPrice) {
          await this.paperTradeRepository.fillPendingTrade({
            paperTradeId: trade.id,
            fillPrice: trade.entryPrice,
            filledAt: candle.closeTime
          });
          filledTradeIds.push(trade.id);
          isFilled = true;
          break;
        }
      }
      
      if (isFilled) continue;
    }

    for (const trade of openTrades) {
      const symKey = trade.instrumentSymbol ? trade.instrumentSymbol.toUpperCase() : "";
      const livePrice = input.livePrices?.[symKey] ?? input.livePrices?.[trade.instrumentId];
      if (livePrice !== undefined && Number.isFinite(livePrice) && livePrice > 0) {
        let decision: { reason: "STOP_LOSS" | "TARGET"; eventType: "STOP_LOSS_HIT" | "TARGET_HIT"; exitPrice: number } | null = null;
        if (trade.side === "LONG") {
          if (livePrice <= trade.stopLoss) {
            decision = { reason: "STOP_LOSS", eventType: "STOP_LOSS_HIT", exitPrice: livePrice };
          } else if (livePrice >= trade.targetPrice) {
            decision = { reason: "TARGET", eventType: "TARGET_HIT", exitPrice: livePrice };
          }
        } else {
          if (livePrice >= trade.stopLoss) {
            decision = { reason: "STOP_LOSS", eventType: "STOP_LOSS_HIT", exitPrice: livePrice };
          } else if (livePrice <= trade.targetPrice) {
            decision = { reason: "TARGET", eventType: "TARGET_HIT", exitPrice: livePrice };
          }
        }

        if (decision) {
          const exitBreakdown = explicitExitFees === undefined
            ? calculateExitFees(decision.exitPrice, trade.quantity)
            : null;
          const closed = await this.paperTradeRepository.close({
            paperTradeId: trade.id,
            exitPrice: decision.exitPrice,
            exitReason: decision.reason,
            closedAt: asOf,
            exitFees: explicitExitFees ?? exitBreakdown!.total,
            exitSlippage,
            feeBreakdown: exitBreakdown ? { ...exitBreakdown } : undefined,
            details: {
              source: "LIVE_MARKET_PRICE_EVALUATOR",
              livePrice,
              fillRule: decision.reason === "TARGET" ? "INTRABAR_TARGET" : "INTRABAR_STOP",
              eventType: decision.eventType,
            },
          });
          closedTradeIds.push(closed.id);
          continue;
        }
      }

      if (!trade.timeframe) {
        skippedWithoutTimeframe += 1;
        continue;
      }
      const candles = await this.candleRepository.listCompleted(trade.instrumentId, trade.timeframe);
      for (const persisted of candles) {
        const candle = toCompletedPriceCandle(persisted);
        if (candle.openTime < trade.openedAt || candle.closeTime > asOf) {
          continue;
        }
        eligibleCandlesRead += 1;
        const decision = decidePaperTradeExit(trade, candle);
        if (!decision) continue;
        const exitBreakdown = explicitExitFees === undefined
          ? calculateExitFees(decision.exitPrice, trade.quantity)
          : null;
        const closed = await this.paperTradeRepository.close({
          paperTradeId: trade.id,
          exitPrice: decision.exitPrice,
          exitReason: decision.reason,
          closedAt: candle.closeTime,
          exitFees: explicitExitFees ?? exitBreakdown!.total,
          exitSlippage,
          feeBreakdown: exitBreakdown ? { ...exitBreakdown } : undefined,
          details: {
            source: "COMPLETED_CANDLE_EVALUATOR",
            candleId: candle.id,
            candleOpenTime: candle.openTime.toISOString(),
            candleCloseTime: candle.closeTime.toISOString(),
            candleOhlc: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
            fillRule: decision.fillRule,
            eventType: decision.eventType,
          },
        });
        closedTradeIds.push(closed.id);
        break;
      }
    }

    return {
      openTradesRead: openTrades.length,
      pendingTradesRead: pendingTrades.length,
      eligibleCandlesRead,
      tradesClosed: closedTradeIds.length,
      closedTradeIds,
      pendingTradesFilled: filledTradeIds.length,
      filledTradeIds,
      pendingTradesCancelled: cancelledTradeIds.length,
      cancelledTradeIds,
      skippedWithoutTimeframe,
    };
  }
}
