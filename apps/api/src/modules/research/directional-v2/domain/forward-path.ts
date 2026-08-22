import type { DecisionPoint } from "./decision-grid.js";
import type { SessionCandle } from "./session-calendar.js";

/**
 * Forward Market Path & Independent Horizon Segments (Phase 29 §3).
 *
 * One canonical ForwardPath per decision point, with independently valid horizon segments:
 * - Horizon 15m, 30m, and 60m evaluate validity independently.
 * - Exact log returns: `10_000 * Math.log(price / referencePrice)`.
 * - Explicit tracking of incremental return curves (0->15, 15->30, 30->60) for signal half-life analysis.
 */

export interface ForwardSegment {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly futurePrice: number;
  readonly cumulativeReturnBps: number;
  readonly incrementalReturnBps: number; // e.g. 15->30 return
  readonly maxForwardReturnBps: number;
  readonly minForwardReturnBps: number;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export interface ForwardPath {
  readonly sampleId: string;
  readonly instrument: string;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly referencePrice: number;
  readonly forward1mCandles: readonly SessionCandle[]; // up to 60 forward 1m candles
  readonly horizon15?: ForwardSegment;
  readonly horizon30?: ForwardSegment;
  readonly horizon60?: ForwardSegment;
}

/**
 * Builds the canonical ForwardPath for a decision point from future intraday candles.
 */
export function buildForwardPathForDecision(
  decision: DecisionPoint,
  allSessionCandles: readonly SessionCandle[],
): ForwardPath {
  const referencePrice = decision.referenceCandle.close;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error(`Invalid reference price for ${decision.sampleId}.`);
  }
  const decisionMs = decision.decisionAt.getTime();
  const sessionCloseMs = decision.session.closeAt.getTime();

  // Filter future 1m candles in the same session (strictly after decisionAt)
  const futureCandles: SessionCandle[] = [];
  for (const candle of allSessionCandles) {
    if (candle.openTime.getTime() >= decisionMs && candle.closeTime.getTime() <= sessionCloseMs) {
      // Keep up to 60 minutes
      if ((candle.closeTime.getTime() - decisionMs) <= 60 * 60_000) {
        futureCandles.push(candle);
      }
    }
  }

  const buildSegment = (
    horizonMinutes: 15 | 30 | 60,
    prevCumulativeReturnBps: number,
  ): ForwardSegment | undefined => {
    const horizonMs = horizonMinutes * 60_000;
    const targetEndMs = decisionMs + horizonMs;

    // Check if horizon target time falls on or before session close
    if (targetEndMs > sessionCloseMs) {
      return undefined;
    }

    // Find candles falling within this horizon window
    const windowCandles = futureCandles.filter((c) => c.closeTime.getTime() <= targetEndMs);
    if (windowCandles.length !== horizonMinutes) {
      return undefined;
    }

    // Every one-minute bar must be present and exactly aligned. Accepting a candle
    // one minute early silently turns a 15m target into a 14m target.
    for (let index = 0; index < windowCandles.length; index += 1) {
      const candle = windowCandles[index]!;
      const expectedOpenMs = decisionMs + index * 60_000;
      if (
        candle.openTime.getTime() !== expectedOpenMs
        || candle.closeTime.getTime() !== expectedOpenMs + 60_000
        || ![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
        || candle.high < Math.max(candle.open, candle.close)
        || candle.low > Math.min(candle.open, candle.close)
      ) {
        return undefined;
      }
    }

    const terminalCandle = windowCandles[windowCandles.length - 1]!;
    if (terminalCandle.closeTime.getTime() !== targetEndMs) {
      return undefined;
    }

    const futurePrice = terminalCandle.close;
    const cumulativeReturnBps = 10_000 * Math.log(futurePrice / referencePrice);
    const incrementalReturnBps = cumulativeReturnBps - prevCumulativeReturnBps;

    let maxPrice = referencePrice;
    let minPrice = referencePrice;
    for (const c of windowCandles) {
      if (c.high > maxPrice) maxPrice = c.high;
      if (c.low < minPrice) minPrice = c.low;
    }

    const maxForwardReturnBps = 10_000 * Math.log(maxPrice / referencePrice);
    const minForwardReturnBps = 10_000 * Math.log(minPrice / referencePrice);

    return {
      horizonMinutes,
      futurePrice,
      cumulativeReturnBps,
      incrementalReturnBps,
      maxForwardReturnBps,
      minForwardReturnBps,
      labelStartAt: decision.decisionAt,
      labelEndAt: terminalCandle.closeTime,
    };
  };

  const horizon15 = buildSegment(15, 0);
  const horizon30 = buildSegment(30, horizon15?.cumulativeReturnBps ?? 0);
  const horizon60 = buildSegment(60, horizon30?.cumulativeReturnBps ?? (horizon15?.cumulativeReturnBps ?? 0));

  return {
    sampleId: decision.sampleId,
    instrument: decision.instrument,
    decisionAt: decision.decisionAt,
    dataThrough: decision.dataThrough,
    referencePrice,
    forward1mCandles: futureCandles,
    horizon15,
    horizon30,
    horizon60,
  };
}
