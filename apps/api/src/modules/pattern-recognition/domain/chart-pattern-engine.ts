import { atrSeries } from "./atr-series.js";
import type {
  DetectedPriceActionEvent,
  PatternCandle,
  PatternDirection,
  PriceActionEventCode,
} from "./market-pattern.js";
import { ZigZagEngine, type ZigZagConfiguration, type ZigZagPivot } from "./zigzag-engine.js";

export interface ChartPatternConfiguration {
  doublePatternTolerance: number;
  flagPoleMinAtr: number;
  flagMaxRetracement: number;
  flagMinBars: number;
  flagMaxBars: number;
  flagMinBoundaryTouches: number;
  triangleHorizontalToleranceAtr: number;
  triangleMinTouches: number;
  triangleMaxBars: number;
  headMinProminenceAtr: number;
  headShoulderToleranceAtr: number;
  necklineMaxSlopeAtrPerBar: number;
  headShoulderMaxBars: number;
  wedgeMinTouchesPerBoundary: number;
  wedgeMinTotalPivots: number;
  wedgeMinConvergenceRate: number;
  wedgeMaxBoundaryErrorAtr: number;
  wedgeMaxBars: number;
  swingWindow: number;
  minimumSwingAtr: number;
  atrPeriod: number;
  tickSize: number;
}

export const defaultChartPatternConfiguration: ChartPatternConfiguration = {
  doublePatternTolerance: 0.15,
  flagPoleMinAtr: 2.0,
  flagMaxRetracement: 0.382,
  flagMinBars: 3,
  flagMaxBars: 20,
  flagMinBoundaryTouches: 2,
  triangleHorizontalToleranceAtr: 0.15,
  triangleMinTouches: 2,
  triangleMaxBars: 50,
  headMinProminenceAtr: 0.5,
  headShoulderToleranceAtr: 0.35,
  necklineMaxSlopeAtrPerBar: 0.15,
  headShoulderMaxBars: 60,
  wedgeMinTouchesPerBoundary: 2,
  wedgeMinTotalPivots: 5,
  wedgeMinConvergenceRate: 0.05,
  wedgeMaxBoundaryErrorAtr: 0.20,
  wedgeMaxBars: 50,
  swingWindow: 2,
  minimumSwingAtr: 0.5,
  atrPeriod: 14,
  tickSize: 0.05,
};

function calculatePatternAtr(
  atrValues: readonly (number | null)[],
  startIndex: number,
  endIndex: number,
  fallbackAtr = 1.0,
): number {
  const values: number[] = [];
  const start = Math.max(0, startIndex);
  const end = Math.min(atrValues.length - 1, endIndex);
  for (let i = start; i <= end; i += 1) {
    const v = atrValues[i];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      values.push(v);
    }
  }
  if (values.length === 0) return fallbackAtr > 0 ? fallbackAtr : 1.0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function event(
  candle: PatternCandle,
  eventCode: PriceActionEventCode,
  direction: PatternDirection,
  level: number | null,
  confidence: number,
  details: Record<string, unknown>,
): DetectedPriceActionEvent {
  return {
    candleId: candle.id,
    eventCode,
    direction,
    level,
    confidence: clamp(confidence),
    details,
  };
}

export class ChartPatternEngine {
  private readonly zigzagEngine: ZigZagEngine;

  constructor(private readonly configuration: ChartPatternConfiguration = defaultChartPatternConfiguration) {
    const zigzagConfig: ZigZagConfiguration = {
      swingWindow: configuration.swingWindow,
      minimumSwingAtr: configuration.minimumSwingAtr,
      atrPeriod: configuration.atrPeriod,
      tickSize: configuration.tickSize,
    };
    this.zigzagEngine = new ZigZagEngine(zigzagConfig);
  }

  detect(candles: readonly PatternCandle[]): DetectedPriceActionEvent[] {
    const results: DetectedPriceActionEvent[] = [];
    if (candles.length < 5) return results;

    const atrValues = atrSeries(candles, this.configuration.atrPeriod);
    const segments = this.zigzagEngine.detectSegments(candles);

    // Extract all unique pivots from segments in order
    const pivots: ZigZagPivot[] = [];
    for (const seg of segments) {
      if (pivots.length === 0) {
        pivots.push(seg.fromPivot);
      }
      pivots.push(seg.toPivot);
    }

    // Map candleId to index for easy lookup
    const candleIndexById = new Map<string, number>();
    candles.forEach((c, idx) => candleIndexById.set(c.id, idx));

    // 1. Double Bottoms & Double Tops
    this.detectDoublePatterns(candles, pivots, atrValues, results, candleIndexById);

    // 2. Flags (Bull Flag & Bear Flag)
    this.detectFlags(candles, pivots, atrValues, results, candleIndexById);

    // 3. Triangles (Ascending & Descending)
    this.detectTriangles(candles, pivots, atrValues, results, candleIndexById);

    // 4. Head and Shoulders (Standard & Inverse)
    this.detectHeadAndShoulders(candles, pivots, atrValues, results, candleIndexById);

    // 5. Wedges (Rising & Falling)
    this.detectWedges(candles, pivots, atrValues, results, candleIndexById);

    // Deduplicate by eventCode and candleId
    const seen = new Set<string>();
    const deduplicated: DetectedPriceActionEvent[] = [];
    for (const ev of results) {
      const key = `${ev.eventCode}_${ev.candleId}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(ev);
      }
    }

    return deduplicated;
  }

  private detectDoublePatterns(
    candles: readonly PatternCandle[],
    pivots: readonly ZigZagPivot[],
    atrValues: readonly (number | null)[],
    results: DetectedPriceActionEvent[],
    candleIndexById: Map<string, number>,
  ): void {
    // Walk through consecutive pivots
    for (let i = 0; i + 2 < pivots.length; i += 1) {
      const p1 = pivots[i];
      const pMid = pivots[i + 1];
      const p2 = pivots[i + 2];

      // Double Bottom: LOW -> HIGH -> LOW
      if (p1.type === "LOW" && pMid.type === "HIGH" && p2.type === "LOW") {
        const atr = atrValues[p2.index] ?? (candles[p2.index].high - candles[p2.index].low);
        const tolerance = atr * this.configuration.doublePatternTolerance;

        if (Math.abs(p1.price - p2.price) <= tolerance) {
          const neckline = pMid.price;
          // Look for breakout candle after p2 confirmation
          const p2ConfIndex = candleIndexById.get(p2.confirmationCandleId) ?? (p2.index + this.configuration.swingWindow);

          for (let cIdx = p2ConfIndex; cIdx < candles.length; cIdx += 1) {
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];

            // Invalidation: if price breaks below the double bottom floor
            const floor = Math.min(p1.price, p2.price) - tolerance;
            if (current.close < floor) break;

            if (current.close > neckline && prev.close <= neckline) {
              results.push(
                event(current, "DOUBLE_BOTTOM", "BULLISH", neckline, 0.75, {
                  leftTrough: p1.price,
                  rightTrough: p2.price,
                  neckline,
                  leftTroughCandleId: p1.candleId,
                  rightTroughCandleId: p2.candleId,
                  midPeakCandleId: pMid.candleId,
                }),
              );
              break; // Emitted once per pattern
            }
          }
        }
      }

      // Double Top: HIGH -> LOW -> HIGH
      if (p1.type === "HIGH" && pMid.type === "LOW" && p2.type === "HIGH") {
        const atr = atrValues[p2.index] ?? (candles[p2.index].high - candles[p2.index].low);
        const tolerance = atr * this.configuration.doublePatternTolerance;

        if (Math.abs(p1.price - p2.price) <= tolerance) {
          const neckline = pMid.price;
          const p2ConfIndex = candleIndexById.get(p2.confirmationCandleId) ?? (p2.index + this.configuration.swingWindow);

          for (let cIdx = p2ConfIndex; cIdx < candles.length; cIdx += 1) {
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];

            // Invalidation: if price breaks above the double top ceiling
            const ceiling = Math.max(p1.price, p2.price) + tolerance;
            if (current.close > ceiling) break;

            if (current.close < neckline && prev.close >= neckline) {
              results.push(
                event(current, "DOUBLE_TOP", "BEARISH", neckline, 0.75, {
                  leftPeak: p1.price,
                  rightPeak: p2.price,
                  neckline,
                  leftPeakCandleId: p1.candleId,
                  rightPeakCandleId: p2.candleId,
                  midTroughCandleId: pMid.candleId,
                }),
              );
              break;
            }
          }
        }
      }
    }
  }

  private detectFlags(
    candles: readonly PatternCandle[],
    pivots: readonly ZigZagPivot[],
    atrValues: readonly (number | null)[],
    results: DetectedPriceActionEvent[],
    candleIndexById: Map<string, number>,
  ): void {
    // Flag requires: Pole (P0 -> P1) + Channel (at least 2 highs and 2 lows)
    for (let i = 0; i + 3 < pivots.length; i += 1) {
      const pPoleStart = pivots[i];
      const pPoleEnd = pivots[i + 1];

      // --- BULL FLAG ---
      if (pPoleStart.type === "LOW" && pPoleEnd.type === "HIGH") {
        const poleHeight = pPoleEnd.price - pPoleStart.price;
        const atr = atrValues[pPoleEnd.index] ?? (candles[pPoleEnd.index].high - candles[pPoleEnd.index].low);

        if (atr > 0 && poleHeight >= this.configuration.flagPoleMinAtr * atr) {
          // Collect channel pivots after pole end
          const channelHighs: ZigZagPivot[] = [];
          const channelLows: ZigZagPivot[] = [];

          for (let j = i + 1; j < pivots.length; j += 1) {
            const p = pivots[j];
            if (p.index - pPoleEnd.index > this.configuration.flagMaxBars) break;
            if (p.type === "HIGH") channelHighs.push(p);
            if (p.type === "LOW") channelLows.push(p);
          }

          if (
            channelHighs.length >= this.configuration.flagMinBoundaryTouches &&
            channelLows.length >= this.configuration.flagMinBoundaryTouches
          ) {
            const h0 = channelHighs[0];
            const h1 = channelHighs[1];
            // Downward-sloping channel: h1 price <= h0 price
            const isDownward = h1.price <= h0.price + this.configuration.tickSize;
            
            // Retracement check: lowest low in channel must not retrace > maxRetracement
            const minLow = Math.min(...channelLows.map((l) => l.price));
            const retracement = (pPoleEnd.price - minLow) / poleHeight;

            if (isDownward && retracement <= this.configuration.flagMaxRetracement) {
              const lastLow = channelLows[channelLows.length - 1];
              const confIdx = candleIndexById.get(lastLow.confirmationCandleId) ?? lastLow.index + this.configuration.swingWindow;

              // Channel upper trendline slope: (h1.price - h0.price) / (h1.index - h0.index)
              const slope = (h1.price - h0.price) / (h1.index - h0.index);

              for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
                if (cIdx - pPoleEnd.index > this.configuration.flagMaxBars) break;
                const current = candles[cIdx];
                const prev = candles[cIdx - 1];
                const trendlineAtCurrent = h0.price + slope * (cIdx - h0.index);
                const trendlineAtPrev = h0.price + slope * (cIdx - 1 - h0.index);

                if (current.close > trendlineAtCurrent && prev.close <= trendlineAtPrev) {
                  results.push(
                    event(current, "BULL_FLAG", "BULLISH", trendlineAtCurrent, 0.70, {
                      poleStart: pPoleStart.price,
                      poleEnd: pPoleEnd.price,
                      poleHeight,
                      retracement,
                      upperBoundary: trendlineAtCurrent,
                    }),
                  );
                  break;
                }
              }
            }
          }
        }
      }

      // --- BEAR FLAG ---
      if (pPoleStart.type === "HIGH" && pPoleEnd.type === "LOW") {
        const poleHeight = pPoleStart.price - pPoleEnd.price;
        const atr = atrValues[pPoleEnd.index] ?? (candles[pPoleEnd.index].high - candles[pPoleEnd.index].low);

        if (atr > 0 && poleHeight >= this.configuration.flagPoleMinAtr * atr) {
          const channelHighs: ZigZagPivot[] = [];
          const channelLows: ZigZagPivot[] = [];

          for (let j = i + 1; j < pivots.length; j += 1) {
            const p = pivots[j];
            if (p.index - pPoleEnd.index > this.configuration.flagMaxBars) break;
            if (p.type === "HIGH") channelHighs.push(p);
            if (p.type === "LOW") channelLows.push(p);
          }

          if (
            channelHighs.length >= this.configuration.flagMinBoundaryTouches &&
            channelLows.length >= this.configuration.flagMinBoundaryTouches
          ) {
            const l0 = channelLows[0];
            const l1 = channelLows[1];
            // Upward-sloping consolidation channel: l1 price >= l0 price
            const isUpward = l1.price >= l0.price - this.configuration.tickSize;

            const maxHigh = Math.max(...channelHighs.map((h) => h.price));
            const retracement = (maxHigh - pPoleEnd.price) / poleHeight;

            if (isUpward && retracement <= this.configuration.flagMaxRetracement) {
              const lastHigh = channelHighs[channelHighs.length - 1];
              const confIdx = candleIndexById.get(lastHigh.confirmationCandleId) ?? lastHigh.index + this.configuration.swingWindow;

              // Channel lower trendline slope: (l1.price - l0.price) / (l1.index - l0.index)
              const slope = (l1.price - l0.price) / (l1.index - l0.index);

              for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
                if (cIdx - pPoleEnd.index > this.configuration.flagMaxBars) break;
                const current = candles[cIdx];
                const prev = candles[cIdx - 1];
                const trendlineAtCurrent = l0.price + slope * (cIdx - l0.index);
                const trendlineAtPrev = l0.price + slope * (cIdx - 1 - l0.index);

                if (current.close < trendlineAtCurrent && prev.close >= trendlineAtPrev) {
                  results.push(
                    event(current, "BEAR_FLAG", "BEARISH", trendlineAtCurrent, 0.70, {
                      poleStart: pPoleStart.price,
                      poleEnd: pPoleEnd.price,
                      poleHeight,
                      retracement,
                      lowerBoundary: trendlineAtCurrent,
                    }),
                  );
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  private detectTriangles(
    candles: readonly PatternCandle[],
    pivots: readonly ZigZagPivot[],
    atrValues: readonly (number | null)[],
    results: DetectedPriceActionEvent[],
    candleIndexById: Map<string, number>,
  ): void {
    // Sliding window of pivots for triangle formation
    for (let i = 0; i + 3 < pivots.length; i += 1) {
      const windowPivots = pivots.slice(i, i + 6); // up to 6 pivots
      const highs = windowPivots.filter((p) => p.type === "HIGH");
      const lows = windowPivots.filter((p) => p.type === "LOW");

      if (
        highs.length >= this.configuration.triangleMinTouches &&
        lows.length >= this.configuration.triangleMinTouches
      ) {
        const spanBars = windowPivots[windowPivots.length - 1].index - windowPivots[0].index;
        if (spanBars > this.configuration.triangleMaxBars) continue;

        const lastPivot = windowPivots[windowPivots.length - 1];
        const atr = atrValues[lastPivot.index] ?? (candles[lastPivot.index].high - candles[lastPivot.index].low);
        const horizTol = (atr ?? 10) * this.configuration.triangleHorizontalToleranceAtr;

        // --- ASCENDING TRIANGLE ---
        // Flat highs + Higher lows
        const maxHigh = Math.max(...highs.map((h) => h.price));
        const minHigh = Math.min(...highs.map((h) => h.price));
        const isFlatHighs = maxHigh - minHigh <= horizTol;

        let isAscendingLows = true;
        for (let lIdx = 1; lIdx < lows.length; lIdx += 1) {
          if (lows[lIdx].price <= lows[lIdx - 1].price + this.configuration.tickSize) {
            isAscendingLows = false;
            break;
          }
        }

        if (isFlatHighs && isAscendingLows) {
          const resistance = (maxHigh + minHigh) / 2;
          const confIdx = candleIndexById.get(lastPivot.confirmationCandleId) ?? lastPivot.index + this.configuration.swingWindow;

          for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
            if (cIdx - windowPivots[0].index > this.configuration.triangleMaxBars) break;
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];

            if (current.close > resistance && prev.close <= resistance) {
              results.push(
                event(current, "ASCENDING_TRIANGLE", "BULLISH", resistance, 0.75, {
                  resistance,
                  lows: lows.map((l) => l.price),
                  highs: highs.map((h) => h.price),
                }),
              );
              break;
            }
          }
        }

        // --- DESCENDING TRIANGLE ---
        // Flat lows + Lower highs
        const maxLow = Math.max(...lows.map((l) => l.price));
        const minLow = Math.min(...lows.map((l) => l.price));
        const isFlatLows = maxLow - minLow <= horizTol;

        let isDescendingHighs = true;
        for (let hIdx = 1; hIdx < highs.length; hIdx += 1) {
          if (highs[hIdx].price >= highs[hIdx - 1].price - this.configuration.tickSize) {
            isDescendingHighs = false;
            break;
          }
        }

        if (isFlatLows && isDescendingHighs) {
          const support = (maxLow + minLow) / 2;
          const confIdx = candleIndexById.get(lastPivot.confirmationCandleId) ?? lastPivot.index + this.configuration.swingWindow;

          for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
            if (cIdx - windowPivots[0].index > this.configuration.triangleMaxBars) break;
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];

            if (current.close < support && prev.close >= support) {
              results.push(
                event(current, "DESCENDING_TRIANGLE", "BEARISH", support, 0.75, {
                  support,
                  lows: lows.map((l) => l.price),
                  highs: highs.map((h) => h.price),
                }),
              );
              break;
            }
          }
        }
      }
    }
  }

  private detectHeadAndShoulders(
    candles: readonly PatternCandle[],
    pivots: readonly ZigZagPivot[],
    atrValues: readonly (number | null)[],
    results: DetectedPriceActionEvent[],
    candleIndexById: Map<string, number>,
  ): void {
    // 5-pivot sequence: P0 -> P1 -> P2 -> P3 -> P4
    for (let i = 0; i + 4 < pivots.length; i += 1) {
      const p0 = pivots[i];
      const p1 = pivots[i + 1];
      const p2 = pivots[i + 2];
      const p3 = pivots[i + 3];
      const p4 = pivots[i + 4];

      const patternAtr = calculatePatternAtr(atrValues, p0.index, p4.index, atrValues[p4.index] ?? 1.0);

      // --- STANDARD HEAD AND SHOULDERS (Bearish Reversal) ---
      // P0(HIGH, Left Shoulder) -> P1(LOW, Left Trough) -> P2(HIGH, Head) -> P3(LOW, Right Trough) -> P4(HIGH, Right Shoulder)
      if (
        p0.type === "HIGH" &&
        p1.type === "LOW" &&
        p2.type === "HIGH" &&
        p3.type === "LOW" &&
        p4.type === "HIGH"
      ) {
        // Head must be strictly higher than both shoulders
        const maxShoulder = Math.max(p0.price, p4.price);
        const headProminence = p2.price - maxShoulder;
        const shoulderDiff = Math.abs(p0.price - p4.price);

        const meetsProminence = headProminence >= this.configuration.headMinProminenceAtr * patternAtr;
        const meetsSymmetry = shoulderDiff <= this.configuration.headShoulderToleranceAtr * patternAtr;

        if (p2.price > p0.price && p2.price > p4.price && meetsProminence && meetsSymmetry) {
          const dx = Math.max(1, p3.index - p1.index);
          const slope = (p3.price - p1.price) / dx;
          const meetsNecklineSlope = Math.abs(slope) <= this.configuration.necklineMaxSlopeAtrPerBar * patternAtr;

          if (meetsNecklineSlope) {
            const confIdx = Math.max(p4.confirmationIndex, candleIndexById.get(p4.confirmationCandleId) ?? p4.index + this.configuration.swingWindow);

            for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
              if (cIdx - p0.index > this.configuration.headShoulderMaxBars) break;
              if (cIdx <= 0) continue;
              const current = candles[cIdx];
              const prev = candles[cIdx - 1];
              const necklineCurrent = p1.price + slope * (cIdx - p1.index);
              const necklinePrev = p1.price + slope * (cIdx - 1 - p1.index);

              // 1-tick breakout cross (prior bar above/at neckline, current bar below)
              if (current.close < necklineCurrent && prev.close >= necklinePrev) {
                results.push(
                  event(current, "HEAD_AND_SHOULDERS", "BEARISH", necklineCurrent, 0.80, {
                    leftShoulder: p0.price,
                    head: p2.price,
                    rightShoulder: p4.price,
                    neckline: necklineCurrent,
                    necklineSlope: slope,
                    patternAtr,
                  }),
                );
                break;
              }
            }
          }
        }
      }

      // --- INVERSE HEAD AND SHOULDERS (Bullish Reversal) ---
      // P0(LOW, Left Shoulder) -> P1(HIGH, Left Peak) -> P2(LOW, Head) -> P3(HIGH, Right Peak) -> P4(LOW, Right Shoulder)
      if (
        p0.type === "LOW" &&
        p1.type === "HIGH" &&
        p2.type === "LOW" &&
        p3.type === "HIGH" &&
        p4.type === "LOW"
      ) {
        // Head must be strictly lower than both shoulders
        const minShoulder = Math.min(p0.price, p4.price);
        const headProminence = minShoulder - p2.price;
        const shoulderDiff = Math.abs(p0.price - p4.price);

        const meetsProminence = headProminence >= this.configuration.headMinProminenceAtr * patternAtr;
        const meetsSymmetry = shoulderDiff <= this.configuration.headShoulderToleranceAtr * patternAtr;

        if (p2.price < p0.price && p2.price < p4.price && meetsProminence && meetsSymmetry) {
          const dx = Math.max(1, p3.index - p1.index);
          const slope = (p3.price - p1.price) / dx;
          const meetsNecklineSlope = Math.abs(slope) <= this.configuration.necklineMaxSlopeAtrPerBar * patternAtr;

          if (meetsNecklineSlope) {
            const confIdx = Math.max(p4.confirmationIndex, candleIndexById.get(p4.confirmationCandleId) ?? p4.index + this.configuration.swingWindow);

            for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
              if (cIdx - p0.index > this.configuration.headShoulderMaxBars) break;
              if (cIdx <= 0) continue;
              const current = candles[cIdx];
              const prev = candles[cIdx - 1];
              const necklineCurrent = p1.price + slope * (cIdx - p1.index);
              const necklinePrev = p1.price + slope * (cIdx - 1 - p1.index);

              // 1-tick breakout cross (prior bar below/at neckline, current bar above)
              if (current.close > necklineCurrent && prev.close <= necklinePrev) {
                results.push(
                  event(current, "INVERSE_HEAD_AND_SHOULDERS", "BULLISH", necklineCurrent, 0.80, {
                    leftShoulder: p0.price,
                    head: p2.price,
                    rightShoulder: p4.price,
                    neckline: necklineCurrent,
                    necklineSlope: slope,
                    patternAtr,
                  }),
                );
                break;
              }
            }
          }
        }
      }
    }
  }

  private detectWedges(
    candles: readonly PatternCandle[],
    pivots: readonly ZigZagPivot[],
    atrValues: readonly (number | null)[],
    results: DetectedPriceActionEvent[],
    candleIndexById: Map<string, number>,
  ): void {
    for (let i = 0; i + 3 < pivots.length; i += 1) {
      const windowPivots = pivots.slice(i, i + 6);
      const highs = windowPivots.filter((p) => p.type === "HIGH");
      const lows = windowPivots.filter((p) => p.type === "LOW");

      if (
        highs.length >= this.configuration.wedgeMinTouchesPerBoundary &&
        lows.length >= this.configuration.wedgeMinTouchesPerBoundary
      ) {
        const pFirst = windowPivots[0];
        const pLast = windowPivots[windowPivots.length - 1];
        if (pLast.index - pFirst.index > this.configuration.wedgeMaxBars) continue;

        const h0 = highs[0];
        const hLast = highs[highs.length - 1];
        const l0 = lows[0];
        const lLast = lows[lows.length - 1];

        const mHigh = (hLast.price - h0.price) / Math.max(1, hLast.index - h0.index);
        const mLow = (lLast.price - l0.price) / Math.max(1, lLast.index - l0.index);

        const patternAtr = calculatePatternAtr(atrValues, pFirst.index, pLast.index, atrValues[pLast.index] ?? 1.0);

        // Boundary fit error check
        let boundaryFitOk = true;
        const maxBoundaryError = this.configuration.wedgeMaxBoundaryErrorAtr * patternAtr;
        for (const h of highs) {
          const fitted = h0.price + mHigh * (h.index - h0.index);
          if (Math.abs(h.price - fitted) > maxBoundaryError) {
            boundaryFitOk = false;
            break;
          }
        }
        if (boundaryFitOk) {
          for (const l of lows) {
            const fitted = l0.price + mLow * (l.index - l0.index);
            if (Math.abs(l.price - fitted) > maxBoundaryError) {
              boundaryFitOk = false;
              break;
            }
          }
        }
        if (!boundaryFitOk) continue;

        const tStart = Math.min(h0.index, l0.index);
        const tEnd = Math.max(hLast.index, lLast.index);
        const upperAtStart = h0.price + mHigh * (tStart - h0.index);
        const lowerAtStart = l0.price + mLow * (tStart - l0.index);
        const upperAtEnd = h0.price + mHigh * (tEnd - h0.index);
        const lowerAtEnd = l0.price + mLow * (tEnd - l0.index);

        const wInitial = upperAtStart - lowerAtStart;
        const wFinal = upperAtEnd - lowerAtEnd;

        // Strict width invariants: W_initial > 0, W_final > 0, W_final < W_initial
        if (wInitial <= 0 || wFinal <= 0 || wFinal >= wInitial) continue;

        const convergenceRate = (wInitial - wFinal) / wInitial;
        if (convergenceRate < this.configuration.wedgeMinConvergenceRate) continue;

        const confIdx = Math.max(pLast.confirmationIndex, candleIndexById.get(pLast.confirmationCandleId) ?? pLast.index + this.configuration.swingWindow);

        // --- RISING WEDGE (Bearish breakdown) ---
        // Slopes upward: mLow > mHigh > 0
        if (mLow > mHigh && mHigh > 0) {
          for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
            if (cIdx - pFirst.index > this.configuration.wedgeMaxBars) break;
            if (cIdx <= 0) continue;
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];
            const supportCurrent = l0.price + mLow * (cIdx - l0.index);
            const supportPrev = l0.price + mLow * (cIdx - 1 - l0.index);

            // 1-tick breakdown cross: prior bar >= support, current bar < support
            if (current.close < supportCurrent && prev.close >= supportPrev) {
              results.push(
                event(current, "RISING_WEDGE", "BEARISH", supportCurrent, 0.75, {
                  upperSlope: mHigh,
                  lowerSlope: mLow,
                  breakoutLevel: supportCurrent,
                  wInitial,
                  wFinal,
                  convergenceRate,
                  patternAtr,
                }),
              );
              break;
            }
          }
        }

        // --- FALLING WEDGE (Bullish breakout) ---
        // Slopes downward: mHigh < mLow < 0 (resistance falling steeper than support)
        if (mHigh < mLow && mLow < 0) {
          for (let cIdx = confIdx; cIdx < candles.length; cIdx += 1) {
            if (cIdx - pFirst.index > this.configuration.wedgeMaxBars) break;
            if (cIdx <= 0) continue;
            const current = candles[cIdx];
            const prev = candles[cIdx - 1];
            const resistanceCurrent = h0.price + mHigh * (cIdx - h0.index);
            const resistancePrev = h0.price + mHigh * (cIdx - 1 - h0.index);

            // 1-tick breakout cross: prior bar <= resistance, current bar > resistance
            if (current.close > resistanceCurrent && prev.close <= resistancePrev) {
              results.push(
                event(current, "FALLING_WEDGE", "BULLISH", resistanceCurrent, 0.75, {
                  upperSlope: mHigh,
                  lowerSlope: mLow,
                  breakoutLevel: resistanceCurrent,
                  wInitial,
                  wFinal,
                  convergenceRate,
                  patternAtr,
                }),
              );
              break;
            }
          }
        }
      }
    }
  }
}
