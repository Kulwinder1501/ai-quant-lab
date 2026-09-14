import type { TradeSide } from "../../../strategy-engine/domain/strategy.js";
import type { ResearchPriceCandle } from "./contracts.js";
import { horizonEligibility } from "./policies.js";

/**
 * The forward market path after a decision, with no bracket attached — stage G1 of the exit-geometry
 * program.
 *
 * ## Why this cannot reuse the settlement walker
 *
 * `walkPath` answers "what did *this bracket* do by horizon H". Its loop returns the instant a stop or
 * target is touched, so every stored 5/15/30/60-minute observation is barrier-truncated. Using those
 * rows to choose a bracket would be circular: the geometry under test would have already decided which
 * part of the path was observed.
 *
 * This walker answers the prior question — "where did price actually go" — and it answers it in a form
 * no exit policy can steer. The guarantee is structural rather than promised: `BarrierFreePathInput`
 * carries no stop, no target and no expiry, so there is nothing in scope for the loop to terminate on.
 * A bar that would have stopped a 1-ATR bracket out is walked straight through, and the +60m figure is
 * computed as though the bracket never existed.
 *
 * ## What it measures from
 *
 * Excursions are measured from the decision's reference price. There is deliberately no fill and no
 * entry condition, which also removes the intrabar-entry problem `walkPath` has to handle: the decision
 * sits at the close of the reference candle, so every forward candle lies wholly after it and its
 * extremes are all legitimately attributable to the post-decision path.
 *
 * ## Not persisted here
 *
 * A pure function, with no identity hash and no storage. The execution record — study hash, code
 * version, dataset cutoff, cohort, session range — belongs to the G1 runner, which must create that
 * record *before* computing and fail closed if it cannot, so a crash between computation and the ledger
 * write cannot leave an unrecorded trial. Hashing here would put half of that guarantee in the wrong
 * place.
 */

export const barrierFreePathPolicyVersion = "BARRIER_FREE_PATH_V1";

export interface BarrierFreePathInput {
  /** Sign convention only: LONG treats up as favourable, SHORT treats down as favourable. */
  readonly direction: TradeSide;
  readonly decisionAt: Date;
  /** The 1m close the decision was taken on. Excursions and returns are measured from it. */
  readonly referencePrice: number;
  readonly sessionCloseAt: Date;
  readonly horizonsMinutes: readonly number[];
  /**
   * ATR at the decision, for volatility-normalised units. Null yields null ATR figures rather than a
   * substituted scale — a NIFTY50 point and a BANKNIFTY point are not the same event, and an invented
   * denominator would hide exactly that.
   */
  readonly atr: number | null;
  readonly forwardCandles: readonly ResearchPriceCandle[];
}

export type BarrierFreeHorizonStatus =
  | "COMPLETE"
  | "DATA_INCOMPLETE"
  | "INELIGIBLE_SESSION_BOUNDARY";

export interface BarrierFreeHorizonObservation {
  readonly horizonMinutes: number;
  readonly status: BarrierFreeHorizonStatus;
  readonly statusReason: string | null;
  readonly barsExpected: number;
  readonly barsObserved: number;
  readonly closePrice: number | null;
  /** Signed so that positive is favourable for this direction, in all three units. */
  readonly directionalReturnPoints: number | null;
  readonly directionalReturnBps: number | null;
  readonly directionalReturnAtr: number | null;
  /** Maximum favourable excursion from the reference price, cumulative to this horizon. */
  readonly mfePoints: number | null;
  readonly mfeBps: number | null;
  readonly mfeAtr: number | null;
  /** Maximum adverse excursion, reported as a positive magnitude. */
  readonly maePoints: number | null;
  readonly maeBps: number | null;
  readonly maeAtr: number | null;
  readonly timeToMfeMinutes: number | null;
  readonly timeToMaeMinutes: number | null;
  /**
   * Share of the favourable peak surrendered by this horizon's close, and its complement.
   *
   * Both are reported because they read differently to a human — "20% of the peak survived" versus "80%
   * was given back" — while being the same number. `retentionRatio` adds no search freedom over the
   * registered `GIVE_BACK_RATIO` statistic (it is `1 - giveBackRatio` by construction), so it needs no
   * new study version; anything that could be *found* in one is already in the other.
   *
   * Null, never zero, when there was no favourable excursion to measure. Zero would assert that a peak
   * existed and none of it was surrendered, which is a different and much stronger claim than "price
   * never traded above the reference at all".
   *
   * Not clamped. A close below the reference after a favourable peak gives give-back above 1 and
   * negative retention, and that is the honest reading of a move that reversed through its start.
   */
  readonly giveBackRatio: number | null;
  readonly retentionRatio: number | null;
}

export interface BarrierFreePathResult {
  readonly policyVersion: string;
  readonly observations: readonly BarrierFreeHorizonObservation[];
}

function assertHorizons(horizons: readonly number[]): void {
  if (horizons.length === 0) throw new Error("A barrier-free path needs at least one horizon.");
  for (const horizon of horizons) {
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new Error(`Barrier-free horizons must be positive whole minutes; got ${horizon}.`);
    }
  }
  const unique = new Set(horizons);
  if (unique.size !== horizons.length) {
    // A duplicate would emit the same horizon twice and double its weight in any aggregate built by
    // iterating the result.
    throw new Error("Barrier-free horizons must be unique.");
  }
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

/**
 * Walks the forward path once and reports every requested horizon from that single pass.
 *
 * Horizons are independent of each other in eligibility and completeness. A missing 1m candle spoils the
 * horizons that needed it and every later one, but leaves the horizons already reached intact — losing
 * the tail of a session should cost the tail of the curve, not the whole observation. That is a real
 * difference from settlement, which has one terminal answer and so must abandon the subject entirely.
 */
export function walkBarrierFreePath(input: BarrierFreePathInput): BarrierFreePathResult {
  assertHorizons(input.horizonsMinutes);
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) {
    throw new Error("A barrier-free path needs a positive reference price.");
  }
  if (Number.isNaN(input.decisionAt.getTime())) {
    throw new Error("A barrier-free path needs a valid decision time.");
  }

  const horizons = [...input.horizonsMinutes].sort((left, right) => left - right);
  const isLong = input.direction === "LONG";
  const reference = input.referencePrice;
  const atr = input.atr !== null && Number.isFinite(input.atr) && input.atr > 0 ? input.atr : null;

  const byClose = new Map<number, ResearchPriceCandle>();
  for (const candle of input.forwardCandles) {
    if (candle.closeTime > input.decisionAt) byClose.set(candle.closeTime.getTime(), candle);
  }

  const points = (favourableMove: number): number => round(favourableMove);
  const bps = (favourableMove: number): number => round((favourableMove / reference) * 10_000);
  const inAtr = (favourableMove: number): number | null =>
    atr === null ? null : round(favourableMove / atr);

  let maximumFavourable = 0;
  let maximumAdverse = 0;
  let timeToMfeMinutes: number | null = null;
  let timeToMaeMinutes: number | null = null;
  let barsObserved = 0;
  let gapAtMinute: number | null = null;
  let lastClose: number | null = null;

  const observations: BarrierFreeHorizonObservation[] = [];
  const ineligible = (horizonMinutes: number): BarrierFreeHorizonObservation => ({
    horizonMinutes,
    status: "INELIGIBLE_SESSION_BOUNDARY",
    statusReason: "SESSION_BOUNDARY",
    barsExpected: horizonMinutes,
    barsObserved: 0,
    closePrice: null,
    directionalReturnPoints: null, directionalReturnBps: null, directionalReturnAtr: null,
    mfePoints: null, mfeBps: null, mfeAtr: null,
    maePoints: null, maeBps: null, maeAtr: null,
    timeToMfeMinutes: null, timeToMaeMinutes: null,
    giveBackRatio: null, retentionRatio: null,
  });

  const incomplete = (horizonMinutes: number, minute: number): BarrierFreeHorizonObservation => ({
    ...ineligible(horizonMinutes),
    status: "DATA_INCOMPLETE",
    statusReason: `MISSING_1M_CANDLE_AT_MINUTE_${minute}`,
    barsObserved,
  });

  const furthest = horizons[horizons.length - 1]!;
  let nextHorizonIndex = 0;

  for (let minute = 1; minute <= furthest; minute += 1) {
    // Emit every horizon that ends before this bar, so an ineligible or already-spoiled horizon does
    // not stall the walk.
    while (nextHorizonIndex < horizons.length && horizons[nextHorizonIndex]! < minute) {
      nextHorizonIndex += 1;
    }

    if (gapAtMinute === null) {
      const candle = byClose.get(input.decisionAt.getTime() + minute * 60_000);
      if (!candle) {
        gapAtMinute = minute;
      } else {
        barsObserved += 1;
        lastClose = candle.close;
        const favourableExtreme = isLong ? candle.high - reference : reference - candle.low;
        const adverseExtreme = isLong ? reference - candle.low : candle.high - reference;
        // Strictly greater, so the *first* minute reaching a peak is the one recorded. A later bar that
        // merely equals it did not extend the move.
        if (favourableExtreme > maximumFavourable) {
          maximumFavourable = favourableExtreme;
          timeToMfeMinutes = minute;
        }
        if (adverseExtreme > maximumAdverse) {
          maximumAdverse = adverseExtreme;
          timeToMaeMinutes = minute;
        }
      }
    }

    if (horizons[nextHorizonIndex] !== minute) continue;
    const horizonMinutes = minute;
    nextHorizonIndex += 1;

    if (!horizonEligibility(input.decisionAt, input.sessionCloseAt, horizonMinutes)) {
      observations.push(ineligible(horizonMinutes));
      continue;
    }
    if (gapAtMinute !== null) {
      observations.push(incomplete(horizonMinutes, gapAtMinute));
      continue;
    }

    const directionalMove = isLong ? lastClose! - reference : reference - lastClose!;
    observations.push({
      horizonMinutes,
      status: "COMPLETE",
      statusReason: null,
      barsExpected: horizonMinutes,
      barsObserved,
      closePrice: lastClose,
      directionalReturnPoints: points(directionalMove),
      directionalReturnBps: bps(directionalMove),
      directionalReturnAtr: inAtr(directionalMove),
      mfePoints: points(maximumFavourable),
      mfeBps: bps(maximumFavourable),
      mfeAtr: inAtr(maximumFavourable),
      maePoints: points(maximumAdverse),
      maeBps: bps(maximumAdverse),
      maeAtr: inAtr(maximumAdverse),
      timeToMfeMinutes: maximumFavourable > 0 ? timeToMfeMinutes : null,
      timeToMaeMinutes: maximumAdverse > 0 ? timeToMaeMinutes : null,
      giveBackRatio: ratio(maximumFavourable - directionalMove, maximumFavourable),
      retentionRatio: ratio(directionalMove, maximumFavourable),
    });
  }

  // Any horizon past the furthest bar walked — only reachable if the caller passed horizons the loop
  // could not reach, which assertHorizons already prevents. Kept as an explicit invariant rather than a
  // silently short result.
  if (observations.length !== horizons.length) {
    throw new Error(
      `Barrier-free walk emitted ${observations.length} of ${horizons.length} horizons. Every requested `
      + "horizon must produce an observation, including an ineligible or incomplete one.",
    );
  }
  return { policyVersion: barrierFreePathPolicyVersion, observations };
}

/**
 * The decisions eligible and complete at *every* horizon in the ladder.
 *
 * The companion to the available-case curve, and the reason both are reported. Horizon eligibility is
 * not constant through a session: a decision taken late cannot support a 60-minute horizon, so the
 * population contributing to +60m is systematically earlier-in-session than the one contributing to
 * +1m. Read alone, a genuine time-of-day effect is indistinguishable from information decay.
 *
 * Agreement between the two curves makes the decay reading credible. Divergence is not an error to
 * correct away — it is evidence that session composition matters, which is its own finding.
 */
export function isCommonEligible(result: BarrierFreePathResult): boolean {
  return result.observations.every((observation) => observation.status === "COMPLETE");
}
