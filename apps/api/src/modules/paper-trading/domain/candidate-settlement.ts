import { resolveBracket } from "../../strategy-engine/domain/bracket-outcome.js";
import type { CompletedPriceCandle } from "./paper-trade-exit-policy.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";
import { measureExcursions } from "./excursions.js";

/**
 * What a candidate would have done, settled forward over its own geometry.
 *
 * This exists because the system throws away almost every decision it makes: 97 candidates a day
 * against 61 closed trades in its whole history, and nothing recorded whether declining the rest was
 * right. `trade_reviews` answers that for trades that were taken; this answers it for the others.
 *
 * ## Index space, and it is not a P&L
 *
 * The idea's stop and target are in **index** space. An executed option trade overrides both into
 * premium space, so `rMultiple` here is not comparable with `trade_reviews.realized_r` and the two
 * must not be pooled into one hit rate. This measures whether the signal was right about the index.
 * A candidate can be right about the index and still lose money as an option, because theta is paid
 * either way -- which is the whole reason the two numbers are named differently.
 *
 * ## Resolution is delegated, never reimplemented
 *
 * `resolveBracket` owns the rules that decide the answer: a gap fills at the open rather than at the
 * level, a bar spanning both levels resolves stop-first because OHLC cannot order them, and nothing
 * resolves from an incomplete bar. It is built on the live exit policy, so a settlement here cannot
 * report a hit rate the paper-trading engine would not have booked.
 */

/** Bumped when the settlement semantics change, so a shift in hit rate is attributable. */
export const candidateResolverVersion = "bracket-outcome-v1";

export type CandidateOutcome = "TARGET" | "STOP" | "UNRESOLVED" | "UNSETTLEABLE";

export interface CandidateSettlement {
  readonly outcome: CandidateOutcome;
  readonly rMultiple: number | null;
  readonly barsToResolution: number | null;
  readonly maeR: number | null;
  readonly mfeR: number | null;
  readonly horizonEnd: Date;
  readonly resolvedTimeframe: string;
  /** Bars inside the horizon that were actually available. Stored so a thin settlement is visible. */
  readonly barsAvailable: number;
  readonly resolverVersion: string;
}

export interface SettleCandidateInput {
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  /** The vertical barrier. The idea's own `expires_at`, which the strategies already compute. */
  readonly horizonEnd: Date;
  readonly resolvedTimeframe: string;
  /** Completed bars after the signal bar, chronological. May over- or under-run the horizon. */
  readonly forwardCandles: readonly CompletedPriceCandle[];
}

function unsettleable(input: SettleCandidateInput, barsAvailable: number): CandidateSettlement {
  return {
    outcome: "UNSETTLEABLE",
    rMultiple: null,
    barsToResolution: null,
    maeR: null,
    mfeR: null,
    horizonEnd: input.horizonEnd,
    resolvedTimeframe: input.resolvedTimeframe,
    barsAvailable,
    resolverVersion: candidateResolverVersion,
  };
}

/**
 * Settles one candidate, or reports that it cannot be settled.
 *
 * ## Why "unresolved" and "unsettleable" must not be the same answer
 *
 * A candidate that never hit either barrier inside a *fully observed* horizon is a real timeout, and
 * it belongs in the denominator. A candidate whose horizon is only partly covered by stored bars is
 * not a timeout -- it is unmeasured. Recording the second as the first is how a hit rate quietly
 * collapses: every gap in the series becomes evidence that the target was not reached. This series has
 * form here, having once returned six weeks of bars for a request spanning two and a half years, so
 * the distinction is enforced rather than trusted.
 *
 * A verdict reached *inside* the available bars stands regardless of what is missing afterwards: if
 * the stop was hit on bar three, bars four onward cannot unhit it.
 */
export function settleCandidate(input: SettleCandidateInput): CandidateSettlement {
  if (Number.isNaN(input.horizonEnd.getTime())) {
    throw new Error("A candidate settlement needs a valid horizon end.");
  }

  // The vertical barrier cuts the window. Without this a candidate could resolve on a bar that closed
  // after its own expiry, crediting an outcome the trade would never have been open for.
  const withinHorizon = input.forwardCandles.filter(
    (candle) => candle.closeTime.getTime() <= input.horizonEnd.getTime(),
  );
  if (withinHorizon.length === 0) {
    return unsettleable(input, 0);
  }

  const resolution = resolveBracket({
    side: input.side,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    targetPrice: input.targetPrice,
  }, withinHorizon);

  const resolved = resolution.outcome === "TARGET" || resolution.outcome === "STOP";
  if (!resolved) {
    // Nothing resolved, so the verdict depends entirely on whether the whole horizon was observed.
    const lastClose = withinHorizon[withinHorizon.length - 1]!.closeTime.getTime();
    if (lastClose < input.horizonEnd.getTime()) {
      return unsettleable(input, withinHorizon.length);
    }
  }

  // Excursions over the bars the position was alive for, not the whole horizon. A candidate stopped
  // out on bar three did not live to see bar four's favourable move.
  const aliveFor = resolution.barsToResolution === null
    ? withinHorizon
    : withinHorizon.slice(0, resolution.barsToResolution);
  const excursions = measureExcursions({
    side: input.side,
    entryPrice: input.entryPrice,
    riskPerUnit: Math.abs(input.entryPrice - input.stopLoss),
    candles: aliveFor,
  });

  return {
    outcome: resolution.outcome,
    rMultiple: resolution.rMultiple,
    barsToResolution: resolution.barsToResolution,
    // Both non-measurements collapse to null here: a settled candidate row records the number or
    // nothing, and a mismatch cannot arise on this path because the candles and the entry price are
    // the same instrument's. The sentinel is defence in depth, not an expected branch.
    maeR: excursions.status === "MEASURED" ? excursions.excursions.maximumAdverseR : null,
    mfeR: excursions.status === "MEASURED" ? excursions.excursions.maximumFavourableR : null,
    horizonEnd: input.horizonEnd,
    resolvedTimeframe: input.resolvedTimeframe,
    barsAvailable: withinHorizon.length,
    resolverVersion: candidateResolverVersion,
  };
}
