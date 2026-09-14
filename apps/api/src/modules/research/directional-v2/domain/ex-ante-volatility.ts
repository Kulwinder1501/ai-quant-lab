import type { DecisionPoint } from "./decision-grid.js";
import type { SessionCandle } from "./session-calendar.js";

/**
 * Ex-Ante Robust Absolute-Return EWMA Volatility Estimator (Phase 29 §2).
 *
 * Implements:
 * - Version: "robust-abs-ewma-v1"
 * - Recursive update: `absEwma_t = lambda * absEwma_{t-1} + (1 - lambda) * |r_1m_bps|`
 * - Normal scale conversion: `sqrt(PI / 2) ≈ 1.253314`
 * - Expanding point-in-time Time-of-Day (TOD) normalization
 * - Horizon scaling: sqrt(T)
 * - Explicit shock diagnostics: shockMagnitude and shockFlag
 */

export const ESTIMATOR_VERSION = "robust-abs-ewma-v1" as const;
export const DEFAULT_LAMBDA = 0.94;
export const VOL_FLOOR_1M_BPS = 2.0;
export const SHOCK_MAGNITUDE_THRESHOLD = 4.0;
const NORMAL_ABS_SCALE = Math.sqrt(Math.PI / 2); // ~1.253314

export interface VolatilityContext {
  readonly estimatorVersion: typeof ESTIMATOR_VERSION;
  readonly volatilityProfileAsOf: Date;
  readonly base1mExpectedVolBps: number;
  readonly expectedVol15mBps: number;
  readonly expectedVol30mBps: number;
  readonly expectedVol60mBps: number;
  readonly shockMagnitude: number;
  readonly shockFlag: boolean;
  readonly ewmaStateBps: number;
}

export interface HistoricalTodProfile {
  /** Map from minuteOfDay bucket (e.g. 0, 5, 10, ...) to relative multiplier */
  readonly todMultipliers: ReadonlyMap<number, number>;
  readonly trainedThroughDate: string;
}

function nseMinuteOfSession(at: Date): number {
  const istMinuteOfDay = Math.floor((at.getTime() + 330 * 60_000) / 60_000) % 1440;
  return istMinuteOfDay - (9 * 60 + 15);
}

/** Incremental builder used to avoid re-scanning all prior sessions for every date. */
export class ExpandingTodProfileBuilder {
  private readonly sumAbsByMinute = new Map<number, number>();
  private readonly countByMinute = new Map<number, number>();
  private totalAbsSum = 0;
  private totalCount = 0;

  addSession(candles: readonly SessionCandle[]): void {
    for (let index = 1; index < candles.length; index += 1) {
      const current = candles[index]!;
      const previous = candles[index - 1]!;
      const minuteOfSession = nseMinuteOfSession(current.openTime);
      if (minuteOfSession < 0 || minuteOfSession >= 375) continue;
      const bucket = Math.floor(minuteOfSession / 5) * 5;
      const absoluteReturn = Math.abs(candleReturnBps(current, previous));
      this.sumAbsByMinute.set(bucket, (this.sumAbsByMinute.get(bucket) ?? 0) + absoluteReturn);
      this.countByMinute.set(bucket, (this.countByMinute.get(bucket) ?? 0) + 1);
      this.totalAbsSum += absoluteReturn;
      this.totalCount += 1;
    }
  }

  snapshot(asOfDateExclusive: string): HistoricalTodProfile {
    const globalMean = this.totalCount > 0 ? this.totalAbsSum / this.totalCount : 1;
    const todMultipliers = new Map<number, number>();
    for (const [bucket, sum] of this.sumAbsByMinute.entries()) {
      const count = this.countByMinute.get(bucket) ?? 1;
      const multiplier = globalMean > 0 ? (sum / count) / globalMean : 1;
      todMultipliers.set(bucket, Math.max(0.2, Math.min(3, multiplier)));
    }
    return { todMultipliers, trainedThroughDate: asOfDateExclusive };
  }
}

/**
 * Computes 1m log return in basis points between two candles.
 */
export function candleReturnBps(current: SessionCandle, previous: SessionCandle): number {
  if (previous.close <= 0 || current.close <= 0) return 0;
  return 10_000 * Math.log(current.close / previous.close);
}

export class RobustAbsEwmaVolatilityEstimator {
  private absEwma: number;
  private readonly lambda: number;
  private readonly volFloorBps: number;

  constructor(initialVolBps = 10.0, lambda = DEFAULT_LAMBDA, volFloorBps = VOL_FLOOR_1M_BPS) {
    if (!Number.isFinite(initialVolBps) || initialVolBps <= 0) throw new Error("initialVolBps must be positive and finite.");
    if (!Number.isFinite(lambda) || lambda < 0 || lambda >= 1) throw new Error("lambda must be in [0, 1).");
    if (!Number.isFinite(volFloorBps) || volFloorBps <= 0) throw new Error("volFloorBps must be positive and finite.");
    this.absEwma = initialVolBps / NORMAL_ABS_SCALE;
    this.lambda = lambda;
    this.volFloorBps = volFloorBps;
  }

  /**
   * Updates the EWMA state with a new 1m observation.
   */
  update(return1mBps: number): number {
    if (!Number.isFinite(return1mBps)) throw new Error("return1mBps must be finite.");
    const absReturn = Math.abs(return1mBps);
    this.absEwma = this.lambda * this.absEwma + (1 - this.lambda) * absReturn;
    return this.absEwma;
  }

  /**
   * Estimates ex-ante volatility for a decision point without lookahead.
   */
  estimateForDecision(
    decision: DecisionPoint,
    todProfile?: HistoricalTodProfile,
  ): VolatilityContext {
    const trailingCandles = decision.trailingSessionCandles;
    let latestReturnBps = 0;

    // Fast-forward EWMA through trailing intraday candles if needed
    if (trailingCandles.length >= 2) {
      const lastCandle = trailingCandles[trailingCandles.length - 1]!;
      const prevCandle = trailingCandles[trailingCandles.length - 2]!;
      latestReturnBps = candleReturnBps(lastCandle, prevCandle);
    }

    const todMultiplier = todProfile?.todMultipliers.get(decision.minuteOfDay) ?? 1.0;
    const raw1mSigma = this.absEwma * NORMAL_ABS_SCALE;
    const base1mExpectedVolBps = Math.max(this.volFloorBps, raw1mSigma * todMultiplier);

    const shockMagnitude = Math.abs(latestReturnBps) / Math.max(raw1mSigma, 1.0);
    const shockFlag = shockMagnitude >= SHOCK_MAGNITUDE_THRESHOLD;

    return {
      estimatorVersion: ESTIMATOR_VERSION,
      volatilityProfileAsOf: decision.dataThrough,
      base1mExpectedVolBps,
      expectedVol15mBps: base1mExpectedVolBps * Math.sqrt(15),
      expectedVol30mBps: base1mExpectedVolBps * Math.sqrt(30),
      expectedVol60mBps: base1mExpectedVolBps * Math.sqrt(60),
      shockMagnitude,
      shockFlag,
      ewmaStateBps: raw1mSigma,
    };
  }
}

/**
 * Builds an expanding Historical TOD Profile from historical sessions strictly prior to the test date.
 */
export function buildExpandingTodProfile(
  historicalSessions: readonly { sessionDate: string; candles: readonly SessionCandle[] }[],
  upToDateExclusive: string,
): HistoricalTodProfile {
  const builder = new ExpandingTodProfileBuilder();
  for (const session of historicalSessions) {
    if (session.sessionDate >= upToDateExclusive) continue;
    builder.addSession(session.candles);
  }
  return builder.snapshot(upToDateExclusive);
}
