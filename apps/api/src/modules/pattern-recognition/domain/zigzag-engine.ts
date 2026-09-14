import { atrSeries } from "./atr-series.js";
import type { PatternCandle } from "./market-pattern.js";
import { PriceActionEngine, atrPriceActionConfiguration } from "./price-action-engine.js";

export interface ZigZagPivot {
  index: number;
  candleId: string;
  confirmationIndex: number;
  confirmationCandleId: string;
  price: number;
  type: "HIGH" | "LOW";
  structure: "HH" | "HL" | "LH" | "LL" | "EQH" | "EQL" | null;
}

export interface ZigZagSegment {
  fromPivot: ZigZagPivot;
  toPivot: ZigZagPivot;
  direction: "UP" | "DOWN";
  magnitudeAtr: number;
}

export interface ZigZagConfiguration {
  swingWindow: number;
  minimumSwingAtr: number;
  atrPeriod: number;
  tickSize: number;
}

const defaultConfiguration: ZigZagConfiguration = {
  swingWindow: 3,
  minimumSwingAtr: 0.5,
  atrPeriod: 14,
  tickSize: 0.05,
};

function isSwingHigh(candles: readonly PatternCandle[], pivotIndex: number, window: number): boolean {
  if (pivotIndex < window || pivotIndex + window >= candles.length) return false;
  const pivot = candles[pivotIndex].high;
  let hasStrictlyLowerNeighbor = false;
  for (let index = pivotIndex - window; index <= pivotIndex + window; index += 1) {
    if (index === pivotIndex) continue;
    if (candles[index].high > pivot) return false;
    if (candles[index].high < pivot) hasStrictlyLowerNeighbor = true;
  }
  return hasStrictlyLowerNeighbor;
}

function isSwingLow(candles: readonly PatternCandle[], pivotIndex: number, window: number): boolean {
  if (pivotIndex < window || pivotIndex + window >= candles.length) return false;
  const pivot = candles[pivotIndex].low;
  let hasStrictlyHigherNeighbor = false;
  for (let index = pivotIndex - window; index <= pivotIndex + window; index += 1) {
    if (index === pivotIndex) continue;
    if (candles[index].low < pivot) return false;
    if (candles[index].low > pivot) hasStrictlyHigherNeighbor = true;
  }
  return hasStrictlyHigherNeighbor;
}

export class ZigZagEngine {
  constructor(private readonly configuration: ZigZagConfiguration = defaultConfiguration) {}

  detectSegments(candles: readonly PatternCandle[]): ZigZagSegment[] {
    const atrValues = atrSeries(candles, this.configuration.atrPeriod);
    const rawPivots: Omit<ZigZagPivot, "structure">[] = [];

    // 1. Detect all local pivots
    for (let index = this.configuration.swingWindow; index < candles.length; index += 1) {
      const current = candles[index];
      const pivotIndex = index - this.configuration.swingWindow;
      const pivotCandle = candles[pivotIndex];

      if (isSwingHigh(candles, pivotIndex, this.configuration.swingWindow)) {
        rawPivots.push({
          index: pivotIndex,
          candleId: pivotCandle.id,
          confirmationIndex: index,
          confirmationCandleId: current.id,
          price: pivotCandle.high,
          type: "HIGH",
        });
      }
      if (isSwingLow(candles, pivotIndex, this.configuration.swingWindow)) {
        rawPivots.push({
          index: pivotIndex,
          candleId: pivotCandle.id,
          confirmationIndex: index,
          confirmationCandleId: current.id,
          price: pivotCandle.low,
          type: "LOW",
        });
      }
    }

    // 2. Filter and alternate
    const filteredPivots: Omit<ZigZagPivot, "structure">[] = [];
    for (const raw of rawPivots) {
      if (filteredPivots.length === 0) {
        filteredPivots.push(raw);
        continue;
      }

      const last = filteredPivots[filteredPivots.length - 1];

      if (raw.type === last.type) {
        // Consecutive same-type pivots
        if (raw.type === "HIGH") {
          // Keep the higher HIGH, or replace if equal (within tickSize)
          if (raw.price > last.price) {
            filteredPivots[filteredPivots.length - 1] = raw;
          } else if (Math.abs(raw.price - last.price) < this.configuration.tickSize) {
             // Equality Rule: completely replace the older pivot (updates index, candleId, confirmationCandleId)
             filteredPivots[filteredPivots.length - 1] = raw;
          }
        } else {
          // Keep the lower LOW, or replace if equal (within tickSize)
          if (raw.price < last.price) {
            filteredPivots[filteredPivots.length - 1] = raw;
          } else if (Math.abs(raw.price - last.price) < this.configuration.tickSize) {
             // Equality Rule: completely replace the older pivot
             filteredPivots[filteredPivots.length - 1] = raw;
          }
        }
      } else {
        // Alternating
        const atr = atrValues[raw.index];
        if (atr !== null && atr > 0) {
          const magnitude = Math.abs(raw.price - last.price) / atr;
          if (magnitude >= this.configuration.minimumSwingAtr) {
            filteredPivots.push(raw);
          } else {
            // Noise pivot. We don't accept it.
            // If we reject a LOW, our last pivot is still a HIGH.
            // But we must check if the raw pivot could have been a better HIGH? No, it's a LOW.
            // Actually, if we reject an alternating pivot, it means the swing wasn't large enough.
            // We just skip it and wait for a proper one.
          }
        } else {
          // Inside ATR warmup, accept it
          filteredPivots.push(raw);
        }
      }
    }

    // 3. Classify structure (HH/HL/LH/LL/EQH/EQL)
    const classifiedPivots: ZigZagPivot[] = [];
    let lastHigh: ZigZagPivot | null = null;
    let lastLow: ZigZagPivot | null = null;

    for (const p of filteredPivots) {
      let structure: ZigZagPivot["structure"] = null;

      if (p.type === "HIGH") {
        if (lastHigh) {
          if (p.price > lastHigh.price + this.configuration.tickSize) structure = "HH";
          else if (p.price < lastHigh.price - this.configuration.tickSize) structure = "LH";
          else structure = "EQH";
        }
      } else {
        if (lastLow) {
          if (p.price > lastLow.price + this.configuration.tickSize) structure = "HL";
          else if (p.price < lastLow.price - this.configuration.tickSize) structure = "LL";
          else structure = "EQL";
        }
      }

      const classified = { ...p, structure };
      classifiedPivots.push(classified);

      if (classified.type === "HIGH") {
        lastHigh = classified;
      } else {
        lastLow = classified;
      }
    }

    // 4. Build Segments
    const segments: ZigZagSegment[] = [];
    for (let i = 1; i < classifiedPivots.length; i += 1) {
      const fromPivot = classifiedPivots[i - 1];
      const toPivot = classifiedPivots[i];
      const atr = atrValues[toPivot.index] ?? 0;
      
      segments.push({
        fromPivot,
        toPivot,
        direction: toPivot.type === "HIGH" ? "UP" : "DOWN",
        magnitudeAtr: atr > 0 ? Math.abs(toPivot.price - fromPivot.price) / atr : 0,
      });
    }

    return segments;
  }
}
