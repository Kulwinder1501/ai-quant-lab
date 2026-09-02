import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { decidePaperTradeExit, type CompletedPriceCandle } from "../domain/paper-trade-exit-policy.js";
import type { PaperTrade, PaperTradeRepository, PaperTradeExitReason } from "../domain/paper-trading.js";
import {
  calculateExitFees,
  calculateExercisedExpiryFees,
} from "../domain/brokerage-calculator.js";
import {
  decideOptionBuyerExit,
  decideOptionBuyerLiveExit,
  decideOptionBuyerObservedExit,
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

interface DenseContractKey {
  underlyingSymbol: string;
  expiryDate: Date;
  strikePrice: number;
  optionType: "CE" | "PE";
}

interface DenseObservation {
  observedAt: Date;
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  underlyingValue: number | null;
}

export interface DenseOptionPremiumReader {
  latestForContract(
    contract: DenseContractKey,
    maxAgeMs?: number,
    now?: Date,
  ): Promise<DenseObservation | null>;
  /**
   * Every observation in `(after, to]`, oldest first, for the barrier scan.
   *
   * Required rather than optional: without it a position's stop is enforced only at the instants
   * this evaluator happens to run, and a reader that silently lacked the method would look
   * identical to a quiet market. Every construction site already passes the Postgres repository.
   */
  listForContractBetween(
    contract: DenseContractKey,
    after: Date,
    to: Date,
  ): Promise<DenseObservation[]>;
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

/**
 * Applies the documented exit policy to closed candles that began after a simulated fill.
 *
 * Option-buyer positions are resolved in a strict order of authority, and it is an order of
 * *evidence quality* rather than convenience:
 *
 * 1. **Expiry settlement** -- the contract no longer exists, so nothing else can apply.
 * 2. **The observed tick series** (`decideOptionBuyerObservedExit`) -- every quoted bid since the
 *    position opened, oldest first. This is the only check that can see a barrier crossed
 *    *between* two runs of this evaluator, and it answers with prices the provider published.
 * 3. **The latest fresh bid** -- one real executable price, for the current instant and for trap
 *    detection. Final in both directions, including when it says hold.
 * 4. **The theoretical model** -- only when no bid exists at all (outside the session, or a strike
 *    outside the collected window). It is an estimate of a price nobody was quoting, and it has
 *    been measured wrong by more than the barrier distances it is asked to resolve.
 *
 * Every step above the model is observed data; the model is the fallback and never overrules one.
 */
export class EvaluateOpenPaperTrades {
  constructor(
    private readonly paperTradeRepository: PaperTradeRepository,
    private readonly candleRepository: CandleRepository,
    private readonly impliedVolatilitySource?: ImpliedVolatilitySource,
    private readonly densePremiums?: DenseOptionPremiumReader,
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
      exitReason: PaperTradeExitReason;
      closedAt: Date;
      details: Record<string, unknown>;
      exercisedIntrinsic?: number;
      /**
       * The underlying's observed level at the exit instant, where the exit path has one.
       *
       * Only the observed-tick barrier scan does: its crossing sample carries the level the provider
       * published alongside that quote. The intrinsic-expiry and latest-quote paths below resolve a
       * price without a sample that pairs an option quote to an underlying level, so they leave this
       * undefined and the column stays null rather than being filled from a reconstruction.
       */
      underlyingExitPrice?: number | null;
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
        underlyingExitPrice: args.underlyingExitPrice ?? null,
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

    const contractKey = {
      underlyingSymbol: trade.underlyingSymbol!,
      expiryDate: expiry,
      strikePrice: trade.optionStrike!,
      optionType: trade.optionType!,
    };

    // The barrier scan, over prices that were actually quoted, and first because the *earliest*
    // crossing is the exit. Everything below it examines a single instant -- the latest quote, or
    // a modelled premium -- and so cannot see a level that was reached and recovered from between
    // two runs of this evaluator. That blind spot is not theoretical: this bot runs every five
    // minutes against a book sampled roughly twice a minute, so it never observes most of the
    // session at all.
    //
    // Samples are read from `openedAt` rather than from the previous evaluation on purpose. There is no
    // stored "last evaluated at", and deriving one would make the answer depend on scheduler
    // history; re-reading the position's whole life is idempotent (a crossing closes the trade,
    // after which it is no longer open) and self-heals positions held through an outage or
    // through the window when this check did not exist. The immutable target is checked across
    // that full history; the stop predicate separately ignores samples before the current stop's
    // persisted effective timestamp, so tightening a stop cannot manufacture a historical exit.
    const observedSamples = await this.densePremiums?.listForContractBetween(
      contractKey,
      trade.openedAt,
      asOf,
    ) ?? [];
    const observedExit = decideOptionBuyerObservedExit(trade, observedSamples, {
      stopLossEffectiveAt: trade.stopLossEffectiveAt,
    });
    if (observedExit) {
      // Deliberately does not touch `eligibleCandlesRead`: no candle was read, and counting a
      // tick-resolved exit there would misreport which evidence closed the position.
      return closeOption({
        exitPrice: observedExit.exitPrice,
        exitReason: observedExit.reason,
        // The moment the barrier was actually crossed, not the moment this noticed.
        closedAt: observedExit.observedAt,
        // From the crossing sample itself, so entry and exit references bracket the same event.
        underlyingExitPrice: observedExit.underlyingValue,
        details: {
          source: "OPTION_PREMIUM_TICK_SERIES",
          quoteObservedAt: observedExit.observedAt.toISOString(),
          bid: observedExit.exitPrice,
          // Recorded so a surprising exit can be re-derived from the tick table: an exit is only
          // as trustworthy as the window it was found in.
          scannedFrom: trade.openedAt.toISOString(),
          scannedTo: asOf.toISOString(),
          stopLossEffectiveAt: trade.stopLossEffectiveAt?.toISOString(),
          samplesScanned: observedSamples.length,
          fillRule: observedExit.fillRule,
          eventType: observedExit.eventType,
          underlyingValue: observedExit.underlyingValue,
        },
      });
    }

    const denseQuote = await this.densePremiums?.latestForContract(
      contractKey,
      2 * 60_000,
      asOf,
    ) ?? null;
    const suppliedLiveSpot = resolveLiveSpot(trade, livePrices);
    const denseSpot = denseQuote?.underlyingValue != null
      && Number.isFinite(denseQuote.underlyingValue) && denseQuote.underlyingValue > 0
      ? denseQuote.underlyingValue
      : undefined;
    const liveSpot = suppliedLiveSpot ?? denseSpot;

    // A long option exits by selling into the bid. The dense series is the only sub-minute
    // executable mark in the system, so it outranks a theoretical premium whenever fresh.
    const quoteIsAfterEntry = denseQuote !== null
      && denseQuote.observedAt.getTime() > trade.openedAt.getTime();
    const freshBid = quoteIsAfterEntry
      && denseQuote?.bid != null && Number.isFinite(denseQuote.bid) && denseQuote.bid > 0
      ? denseQuote.bid
      : null;
    if (freshBid !== null) {
      const decision = decideOptionBuyerLiveExit(trade, freshBid, liveSpot);
      if (decision) {
        return closeOption({
          exitPrice: freshBid,
          exitReason: decision.reason,
          closedAt: asOf,
          // denseSpot, not liveSpot: it comes from the same tick as freshBid, so the option and
          // underlying levels describe one instant rather than two nearby ones.
          underlyingExitPrice: denseSpot ?? null,
          details: {
            source: "OPTION_PREMIUM_TICK_BID",
            quoteObservedAt: denseQuote!.observedAt.toISOString(),
            bid: freshBid,
            ask: denseQuote!.ask,
            lastPrice: denseQuote!.lastPrice,
            spot: liveSpot,
            fillRule: decision.reason === "TARGET" ? "INTRABAR_TARGET" : (decision.reason === "TRAP_DETECTED" ? "TRAP_DETECTED" : "INTRABAR_STOP"),
            eventType: decision.eventType,
          },
        });
      }
      // A fresh executable bid that does not trigger governs the HOLD, and it governs it
      // *completely* -- hence the return rather than a fall-through to the theoretical paths.
      //
      // This used to fall through, on the reasoning that the completed-candle path answers a
      // different question (a barrier crossed between sparse evaluations) that a point-in-time
      // quote cannot see. It does, but it answers it with `priceOptionMarksAtOhlc`, whose error
      // is larger than the barrier it is asked to resolve. Measured on this account 2026-08-13:
      // a BANKNIFTY 57700 CE was booked STOP_LOSS at a theoretical 519.58 while the real book
      // was bid 576-581 -- above the position's own 579.36 target. The model was ~50 points
      // (~10%) below the market on a stop sitting 21 points (~4%) from entry, so the estimate's
      // noise was more than twice the distance it was measuring, and the exit it produced was
      // a coin toss dressed as a stop. The same run stopped a NIFTY 24400 CE out by one paisa.
      //
      // So the theoretical marks are a last resort, not a second opinion: they stay reachable
      // below for contracts with no fresh bid (outside the session, or outside the collected
      // strike window), and are never allowed to overrule a live market that says hold.
      //
      // Nothing is lost by returning here. The barrier-crossing question the completed-candle
      // path was reaching for is answered above by `decideOptionBuyerObservedExit`, against
      // observed bids instead of estimated ones.
      // Momentum Stall Stop (5m timeframe, elapsed market time >= 20 mins, gain < 0.5R)
      // We apply this strict time limit only to scalp setups (Reward/Risk <= 1.6).
      // Directional setups (target ~2R+) are given more room to breathe and form the trend.
      if (trade.timeframe === "5m") {
        const elapsedMinutes = (asOf.getTime() - trade.openedAt.getTime()) / 60_000;
        const initialRisk = trade.entryPrice - trade.stopLoss;
        const initialReward = trade.targetPrice - trade.entryPrice;
        const isScalp = initialRisk > 0 ? (initialReward / initialRisk) <= 1.6 : false;
        
        if (isScalp && elapsedMinutes >= 20 && initialRisk > 0 && freshBid < trade.entryPrice + 0.5 * initialRisk) {
          return closeOption({
            exitPrice: freshBid,
            exitReason: "MOMENTUM_STALL",
            closedAt: asOf,
            underlyingExitPrice: denseSpot ?? null,
            details: {
              source: "MOMENTUM_STALL_EVALUATOR",
              elapsedMinutes,
              freshBid,
              entryPrice: trade.entryPrice,
              initialRisk,
              initialReward,
              isScalp,
              eventType: "MANUALLY_CLOSED",
            },
          });
        }
      }

      return null;
    }

    // A pre-entry quote is not evidence about a position that did not yet exist. Production
    // supplies the dense reader for every option position, so if no post-entry executable bid is
    // available the safe answer is HOLD. Falling through to Black-Scholes here was the exact
    // failure that booked a 47.96% same-millisecond loss: a model entry near 124.65 was compared
    // with a real 65.65 bid observed 34 seconds before the trade opened.
    if (this.densePremiums) {
      return null;
    }

    const volatility = await this.resolveVolatility(trade, asOf);
    if (volatility === null) {
      return null;
    }

    // Everything from here down is the no-fresh-bid fallback: the early return above means
    // `freshBid` is necessarily null by this point, so these paths only ever estimate a premium
    // nothing was quoting.
    if (liveSpot !== undefined) {
      const mark = priceOptionMark({ trade, spot: liveSpot, asOf, volatility });
      const decision = decideOptionBuyerLiveExit(trade, mark.premium, liveSpot);
      if (decision) {
        return closeOption({
          exitPrice: decision.exitPrice,
          exitReason: decision.reason,
          closedAt: asOf,
          /*
           * Recorded even though the *option* price on this path is modelled rather than quoted.
           * The two are independent: `liveSpot` is an observed underlying level, and it stays
           * observed regardless of how the premium beside it was derived. The option leg's
           * provenance is carried separately by `source` here and by `priceSource` on the outcome,
           * so nothing reads a modelled premium as a fill because of this field.
           */
          underlyingExitPrice: liveSpot,
          details: {
            source: "OPTION_LIVE_MARK_EVALUATOR",
            spot: liveSpot,
            volatility,
            markPremium: mark.premium,
            timeToExpiryYears: mark.timeToExpiryYears,
            greeks: mark.greeks,
            fillRule: decision.reason === "TARGET" ? "INTRABAR_TARGET" : (decision.reason === "TRAP_DETECTED" ? "TRAP_DETECTED" : "INTRABAR_STOP"),
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
