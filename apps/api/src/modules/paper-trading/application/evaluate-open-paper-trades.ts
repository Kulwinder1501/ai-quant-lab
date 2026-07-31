import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { decidePaperTradeExit, type CompletedPriceCandle } from "../domain/paper-trade-exit-policy.js";
import type { PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";
import {
  calculateExitFees,
  calculateExercisedExpiryFees,
} from "../domain/brokerage-calculator.js";
import {
  decideOptionBuyerExit,
  decideOptionBuyerLiveExit,
  isOptionBuyerTrade,
  priceOptionMark,
  priceOptionMarksAtOhlc,
} from "../domain/option-mark-to-market.js";
import type { ImpliedVolatilitySource } from "../infrastructure/india-vix-implied-volatility-source.js";

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
  /**
   * Trades whose evaluation threw, reported rather than swallowed.
   *
   * A trade that could not be evaluated has an un-enforced stop, so it must be visible.
   * Returning it lets one invalid row be isolated without the failure disappearing —
   * a silent catch would be worse than the crash it replaces.
   */
  evaluationFailures: EvaluationFailure[];
}

export interface EvaluationFailure {
  tradeId: string;
  message: string;
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

function resolveLiveSpot(trade: PaperTrade, livePrices?: Record<string, number>): number | undefined {
  if (!livePrices) return undefined;
  const keys = [
    trade.underlyingSymbol?.toUpperCase(),
    trade.instrumentSymbol?.toUpperCase(),
    trade.instrumentId,
  ].filter((key): key is string => typeof key === "string" && key.length > 0);

  for (const key of keys) {
    const price = livePrices[key];
    if (price !== undefined && Number.isFinite(price) && price > 0) {
      return price;
    }
  }
  return undefined;
}

/** Applies the documented exit policy to closed candles that began after a simulated fill. */
export class EvaluateOpenPaperTrades {
  constructor(
    private readonly paperTradeRepository: PaperTradeRepository,
    private readonly candleRepository: CandleRepository,
    private readonly impliedVolatilitySource?: ImpliedVolatilitySource,
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
    const evaluationFailures: EvaluationFailure[] = [];
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
            filledAt: asOf,
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
            filledAt: candle.closeTime,
          });
          filledTradeIds.push(trade.id);
          isFilled = true;
          break;
        }
      }

      if (isFilled) continue;
    }

    // Each trade is evaluated in isolation. `decideOptionBuyerExit`,
    // `decideOptionBuyerLiveExit`, and `priceOptionMark` all throw on a contract they
    // cannot model, and this loop used to let that abort the whole account: one invalid
    // row and every later trade went unevaluated, so stops silently stopped firing while
    // the symptom read as a broken evaluator. Failures are collected and returned rather
    // than swallowed, because a trade that could not be evaluated has an unenforced stop.
    const evaluateOne = async (trade: PaperTrade): Promise<void> => {
      if (isOptionBuyerTrade(trade)) {
        const closed = await this.evaluateOptionBuyerTrade({
          trade,
          asOf,
          livePrices: input.livePrices,
          explicitExitFees,
          exitSlippage,
          onEligibleCandle: () => { eligibleCandlesRead += 1; },
        });
        if (closed) {
          closedTradeIds.push(closed);
        } else if (!trade.timeframe) {
          skippedWithoutTimeframe += 1;
        }
        return;
      }

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
          return;
        }
      }

      if (!trade.timeframe) {
        skippedWithoutTimeframe += 1;
        return;
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
    };

    for (const trade of openTrades) {
      try {
        await evaluateOne(trade);
      } catch (error) {
        evaluationFailures.push({
          tradeId: trade.id,
          message: error instanceof Error ? error.message : String(error),
        });
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
      evaluationFailures,
    };
  }

  private async resolveVolatility(trade: PaperTrade, asOf: Date): Promise<number | null> {
    const live = await this.impliedVolatilitySource?.resolveAsOf(asOf);
    if (live != null && Number.isFinite(live) && live > 0) {
      return live;
    }
    if (trade.entryIv != null && Number.isFinite(trade.entryIv) && trade.entryIv > 0) {
      return trade.entryIv;
    }
    return null;
  }

  private async evaluateOptionBuyerTrade(input: {
    trade: PaperTrade;
    asOf: Date;
    livePrices?: Record<string, number>;
    explicitExitFees?: number;
    exitSlippage: number;
    onEligibleCandle: () => void;
  }): Promise<string | null> {
    const { trade, asOf, livePrices, explicitExitFees, exitSlippage } = input;
    const expiry = trade.optionExpiry!;

    const closeOption = async (args: {
      exitPrice: number;
      exitReason: "STOP_LOSS" | "TARGET" | "EXPIRED";
      closedAt: Date;
      details: Record<string, unknown>;
      exercisedIntrinsic?: number;
    }): Promise<string> => {
      let exitBreakdown = null;
      if (explicitExitFees === undefined) {
        if (args.exitReason === "EXPIRED") {
          exitBreakdown = args.exitPrice > 0
            ? calculateExercisedExpiryFees(args.exercisedIntrinsic ?? args.exitPrice, trade.quantity)
            : calculateExitFees(0, trade.quantity);
        } else {
          exitBreakdown = calculateExitFees(args.exitPrice, trade.quantity);
        }
      }
      const closed = await this.paperTradeRepository.close({
        paperTradeId: trade.id,
        exitPrice: args.exitPrice,
        exitReason: args.exitReason,
        closedAt: args.closedAt,
        exitFees: explicitExitFees ?? exitBreakdown!.total,
        exitSlippage,
        feeBreakdown: exitBreakdown ? { ...exitBreakdown } : undefined,
        details: args.details,
      });
      return closed.id;
    };

    // Force-close at/after expiry using intrinsic settlement mark.
    if (asOf.getTime() >= expiry.getTime()) {
      const spot = resolveLiveSpot(trade, livePrices)
        ?? await this.latestCompletedClose(trade, asOf);
      if (spot === undefined) {
        return null;
      }
      const volatility = (await this.resolveVolatility(trade, asOf)) ?? 0.12;
      const mark = priceOptionMark({ trade, spot, asOf: expiry, volatility });
      return closeOption({
        exitPrice: mark.premium,
        exitReason: "EXPIRED",
        closedAt: asOf.getTime() > expiry.getTime() ? asOf : expiry,
        exercisedIntrinsic: mark.greeks.intrinsicValue,
        details: {
          source: "OPTION_EXPIRY_SETTLEMENT",
          spot,
          volatility,
          premium: mark.premium,
          intrinsicValue: mark.greeks.intrinsicValue,
          optionStrike: trade.optionStrike,
          optionType: trade.optionType,
          optionExpiry: expiry.toISOString(),
          eventType: "EXPIRED",
        },
      });
    }

    const volatility = await this.resolveVolatility(trade, asOf);
    if (volatility === null) {
      return null;
    }

    const liveSpot = resolveLiveSpot(trade, livePrices);
    if (liveSpot !== undefined) {
      const mark = priceOptionMark({ trade, spot: liveSpot, asOf, volatility });
      const decision = decideOptionBuyerLiveExit(trade, mark.premium);
      if (decision) {
        return closeOption({
          exitPrice: decision.exitPrice,
          exitReason: decision.reason,
          closedAt: asOf,
          details: {
            source: "OPTION_LIVE_MARK_EVALUATOR",
            spot: liveSpot,
            volatility,
            markPremium: mark.premium,
            timeToExpiryYears: mark.timeToExpiryYears,
            greeks: mark.greeks,
            fillRule: decision.reason === "TARGET" ? "INTRABAR_TARGET" : "INTRABAR_STOP",
            eventType: decision.eventType,
          },
        });
      }
    }

    if (!trade.timeframe) {
      return null;
    }

    const candles = await this.candleRepository.listCompleted(trade.instrumentId, trade.timeframe);
    for (const persisted of candles) {
      const candle = toCompletedPriceCandle(persisted);
      if (candle.openTime < trade.openedAt || candle.closeTime > asOf) {
        continue;
      }
      // Do not evaluate bars that close after the contract has expired.
      if (candle.closeTime.getTime() > expiry.getTime()) {
        continue;
      }
      input.onEligibleCandle();
      const barIv = (await this.resolveVolatility(trade, candle.closeTime)) ?? volatility;
      const marks = priceOptionMarksAtOhlc({ trade, candle, volatility: barIv });
      const decision = decideOptionBuyerExit(trade, candle, marks);
      if (!decision) continue;
      return closeOption({
        exitPrice: decision.exitPrice,
        exitReason: decision.reason,
        closedAt: candle.closeTime,
        details: {
          source: "OPTION_COMPLETED_CANDLE_EVALUATOR",
          candleId: candle.id,
          candleOpenTime: candle.openTime.toISOString(),
          candleCloseTime: candle.closeTime.toISOString(),
          underlyingOhlc: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
          premiumMarks: marks,
          volatility: barIv,
          fillRule: decision.fillRule,
          eventType: decision.eventType,
        },
      });
    }

    return null;
  }

  private async latestCompletedClose(trade: PaperTrade, asOf: Date): Promise<number | undefined> {
    if (!trade.timeframe) return undefined;
    const candles = await this.candleRepository.listCompleted(trade.instrumentId, trade.timeframe);
    let latest: number | undefined;
    let latestCloseTime = 0;
    for (const candle of candles) {
      if (candle.closeTime.getTime() > asOf.getTime()) continue;
      if (candle.closeTime.getTime() >= latestCloseTime) {
        const close = Number(candle.close);
        if (Number.isFinite(close) && close > 0) {
          latest = close;
          latestCloseTime = candle.closeTime.getTime();
        }
      }
    }
    return latest;
  }
}
