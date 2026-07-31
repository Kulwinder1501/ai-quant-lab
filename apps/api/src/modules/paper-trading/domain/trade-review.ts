import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/**
 * Thresholds that turn measured excursions into research tags.
 *
 * Named rather than inlined so a reader can see what "nearly hit the stop" means,
 * and so tuning them is a visible change. They are diagnostic boundaries only --
 * nothing in the trading path reads them.
 */
export const tradeReviewThresholds = {
  /** MFE at or above this on a losing trade means the trade was winning and gave it back. */
  gaveBackFavourableR: 1,
  /** MAE at or above this on a winning trade means the stop was nearly taken out first. */
  stopNearlyHitR: 0.9,
  /** MFE below this means the trade never moved meaningfully in favour. */
  noFollowThroughR: 0.25,
  /**
   * How far below its favourable peak a *winning* trade must finish to be worth
   * flagging. Losers are covered by `gaveBackFavourableR`; a winner that reached 3R
   * and banked 2R is still a geometry finding -- the target may be too near or the
   * exit too early -- and without this the case is invisible.
   */
  exitedBelowPeakR: 1,
  /**
   * A loss worse than this could not have been a clean stop fill at its level.
   * Slightly beyond 1R rather than exactly 1R so ordinary fee and slippage drag
   * is not reported as the stop being violated.
   */
  lossExceededStopR: -1.05,
} as const;

/** Only the extremes matter, so a review candle is deliberately narrower than a full candle. */
export interface TradeReviewCandle {
  openTime: Date;
  high: number;
  low: number;
}

export interface TradeReviewInput {
  tradeId: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  targetPrice: number;
  realizedPnl: number;
  /** As recorded on the trade. Never inferred from the sign of the P&L. */
  exitReason: string | null;
  /** Candles covering the holding period, and the timeframe they were read at. */
  candles: readonly TradeReviewCandle[];
  observedTimeframe: string | null;
}

export interface TradeReview {
  tradeId: string;
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  exitReason: string | null;
  realizedPnl: number;
  /** Initial risk per unit, from the trade's own entry and stop. */
  riskPerUnit: number;
  /** Net P&L in multiples of initial risk. */
  realizedR: number;
  /** Worst unrealised move against the position, in price points. Never negative. */
  maximumAdverseExcursion: number | null;
  /** Best unrealised move in favour, in price points. Never negative. */
  maximumFavourableExcursion: number | null;
  maximumAdverseExcursionR: number | null;
  maximumFavourableExcursionR: number | null;
  candlesObserved: number;
  observedTimeframe: string | null;
  /** Statements derived from the numbers above. No inferred causation. */
  observations: string[];
  /** Suggestions for offline research. Nothing acts on these automatically. */
  proposedResearchTags: string[];
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Trade review requires a positive ${field}.`);
  }
}

/**
 * Builds an auditable review of a closed trade.
 *
 * The point of this over a written summary is maximum adverse and favourable
 * excursion. Realised P&L says whether a trade worked; MAE and MFE say whether the
 * *geometry* was right -- whether the stop was nearly hit before a winner worked,
 * whether a loser was in profit first, whether a loss was larger than the stop
 * should have allowed. Diagnosing momentum-scalp's realised 0.58:1 reward-to-risk
 * required reconstructing exactly this from exit populations after the fact.
 *
 * Excursions are read from candle extremes, so they are an **upper bound**: the
 * path inside a candle is unknown, and a single candle containing both the entry and
 * the exit reports its full range. Precision therefore depends on the timeframe the
 * candles were read at, which is recorded alongside the numbers so a reader can tell
 * a 1m-derived excursion from a 1d-derived one.
 */
export function buildTradeReview(input: TradeReviewInput): TradeReview {
  assertFinitePositive(input.entryPrice, "entry price");
  assertFinitePositive(input.quantity, "quantity");
  assertFinitePositive(input.stopLoss, "stop loss");
  if (!Number.isFinite(input.realizedPnl)) {
    throw new Error("Trade review requires a finite realised P&L.");
  }

  const riskPerUnit = Math.abs(input.entryPrice - input.stopLoss);
  if (riskPerUnit <= 0) {
    throw new Error("Trade review requires a stop loss different from the entry price.");
  }
  const riskAmount = riskPerUnit * input.quantity;
  const realizedR = input.realizedPnl / riskAmount;

  const outcome = input.realizedPnl > 0 ? "WIN" : input.realizedPnl < 0 ? "LOSS" : "BREAKEVEN";

  const observations: string[] = [];
  const proposedResearchTags: string[] = [];

  // Stated, not inferred. The previous implementation derived "hit Target Profit"
  // from a positive P&L, which mislabelled every profitable manual close.
  observations.push(
    `Closed ${input.exitReason ?? "with no recorded exit reason"} at ${input.exitPrice.toFixed(2)} `
    + `for ${rounded(realizedR)}R (${input.realizedPnl.toFixed(2)} on ${rounded(riskAmount)} at risk).`,
  );
  if (input.exitReason === null) {
    proposedResearchTags.push("MISSING_EXIT_REASON");
  } else if (input.exitReason !== "TARGET" && input.exitReason !== "STOP_LOSS") {
    observations.push(`Exit was neither the stop nor the target, so the trade's own geometry did not resolve it.`);
    proposedResearchTags.push("EXIT_OUTSIDE_GEOMETRY");
  }

  let maximumAdverseExcursion: number | null = null;
  let maximumFavourableExcursion: number | null = null;
  let maximumAdverseExcursionR: number | null = null;
  let maximumFavourableExcursionR: number | null = null;

  if (input.candles.length === 0) {
    observations.push("No holding-period candles were available, so excursions could not be measured.");
    proposedResearchTags.push("NO_HOLDING_PERIOD_DATA");
  } else {
    const highest = Math.max(...input.candles.map((candle) => candle.high));
    const lowest = Math.min(...input.candles.map((candle) => candle.low));
    const worstPrice = input.side === "LONG" ? lowest : highest;
    const bestPrice = input.side === "LONG" ? highest : lowest;

    // Clamped at zero: a position that never traded against the entry has no adverse
    // excursion, and a negative one would be a favourable move wearing the wrong sign.
    maximumAdverseExcursion = rounded(Math.max(0, input.side === "LONG"
      ? input.entryPrice - worstPrice
      : worstPrice - input.entryPrice));
    maximumFavourableExcursion = rounded(Math.max(0, input.side === "LONG"
      ? bestPrice - input.entryPrice
      : input.entryPrice - bestPrice));
    maximumAdverseExcursionR = rounded(maximumAdverseExcursion / riskPerUnit);
    maximumFavourableExcursionR = rounded(maximumFavourableExcursion / riskPerUnit);

    observations.push(
      `Ran ${maximumFavourableExcursionR}R in favour and ${maximumAdverseExcursionR}R against `
      + `over ${input.candles.length} ${input.observedTimeframe ?? "unknown-timeframe"} candle(s).`,
    );

    if (outcome !== "WIN" && maximumFavourableExcursionR >= tradeReviewThresholds.gaveBackFavourableR) {
      observations.push(
        `Reached ${maximumFavourableExcursionR}R before finishing at ${rounded(realizedR)}R, so a profitable `
        + "position was given back rather than never existing.",
      );
      proposedResearchTags.push("GAVE_BACK_FAVOURABLE_MOVE");
    }
    if (outcome === "WIN" && maximumFavourableExcursionR - realizedR >= tradeReviewThresholds.exitedBelowPeakR) {
      observations.push(
        `Peaked at ${maximumFavourableExcursionR}R but banked ${rounded(realizedR)}R, leaving `
        + `${rounded(maximumFavourableExcursionR - realizedR)}R behind.`,
      );
      proposedResearchTags.push("EXITED_BELOW_PEAK");
    }
    if (outcome === "WIN" && maximumAdverseExcursionR >= tradeReviewThresholds.stopNearlyHitR) {
      observations.push(
        `Came within ${rounded(1 - maximumAdverseExcursionR)}R of the stop before working, so this winner `
        + "was close to being a loser on stop placement alone.",
      );
      proposedResearchTags.push("STOP_NEARLY_HIT");
    }
    if (maximumFavourableExcursionR < tradeReviewThresholds.noFollowThroughR) {
      observations.push(`Never moved more than ${maximumFavourableExcursionR}R in favour.`);
      proposedResearchTags.push("NO_FOLLOW_THROUGH");
    }
  }

  if (realizedR <= tradeReviewThresholds.lossExceededStopR) {
    observations.push(
      `Lost ${rounded(Math.abs(realizedR))}R against a 1R stop, so the exit did not fill at the stop level.`,
    );
    proposedResearchTags.push("LOSS_EXCEEDED_STOP");
  }

  return {
    tradeId: input.tradeId,
    outcome,
    exitReason: input.exitReason,
    realizedPnl: rounded(input.realizedPnl),
    riskPerUnit: rounded(riskPerUnit),
    realizedR: rounded(realizedR),
    maximumAdverseExcursion,
    maximumFavourableExcursion,
    maximumAdverseExcursionR,
    maximumFavourableExcursionR,
    candlesObserved: input.candles.length,
    observedTimeframe: input.observedTimeframe,
    observations,
    proposedResearchTags,
  };
}
