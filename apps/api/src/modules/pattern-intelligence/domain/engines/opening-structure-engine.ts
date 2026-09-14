import type {
  OpeningStructureDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface OpeningStructureCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: OpeningStructureDetails["subtype"];
  orientation: PatternOrientation;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeBps: number;
  patternHigh: number;
  patternLow: number;
}

export interface OpeningStructureEngineConfig {
  openingRangeMinutes: number; // e.g. 15 or 30 minutes
}

export const defaultOpeningStructureConfig: OpeningStructureEngineConfig = {
  openingRangeMinutes: 15,
};

export class OpeningStructureEngine {
  constructor(private readonly config: OpeningStructureEngineConfig = defaultOpeningStructureConfig) {}

  detect(candles: readonly CandleLike[]): OpeningStructureCandidate[] {
    if (candles.length < 2) return [];
    const candidates: OpeningStructureCandidate[] = [];

    // Group candles into session days
    // Opening range is defined as the first N minutes of the continuous session (09:15 to 09:15+N)
    let sessionCandles: { candle: CandleLike; index: number }[] = [];
    let currentSessionDate = "";

    const processSession = (session: { candle: CandleLike; index: number }[]) => {
      if (session.length < 3) return;

      // Identify opening range bars (e.g. 09:15 to 09:30 IST)
      // Opening range bars: first 3 bars for 5m, or first 15 bars for 1m
      const firstBarTime = session[0]!.candle.openTime;
      const orBars = session.filter((s) => {
        const diffMinutes = (s.candle.openTime.getTime() - firstBarTime.getTime()) / (60 * 1000);
        return diffMinutes < this.config.openingRangeMinutes;
      });

      if (orBars.length === 0) return;

      const orHigh = Math.max(...orBars.map((b) => b.candle.high));
      const orLow = Math.min(...orBars.map((b) => b.candle.low));
      const midpoint = (orHigh + orLow) / 2;
      const orBps = midpoint > 0 ? ((orHigh - orLow) / midpoint) * 10000 : 0;
      const orEndIndex = orBars[orBars.length - 1]!.index;

      // 1. Opening Drive: First bar has long body, opens near one extreme and closes near the other
      const firstCandle = session[0]!.candle;
      const firstRange = firstCandle.high - firstCandle.low;
      const firstBody = Math.abs(firstCandle.close - firstCandle.open);
      if (firstRange > 0 && firstBody / firstRange >= 0.75) {
        const isUp = firstCandle.close > firstCandle.open;
        candidates.push({
          startIndex: session[0]!.index,
          detectedIndex: session[0]!.index,
          subtype: "OPENING_DRIVE",
          orientation: isUp ? "UP" : "DOWN",
          openingRangeHigh: orHigh,
          openingRangeLow: orLow,
          openingRangeBps: Number(orBps.toFixed(6)),
          patternHigh: firstCandle.high,
          patternLow: firstCandle.low,
        });
      }

      // 2. Evaluate subsequent bars post opening range
      const postOrBars = session.filter((s) => s.index > orEndIndex);
      let brokeHigh = false;
      let brokeLow = false;

      for (let k = 0; k < postOrBars.length; k++) {
        const item = postOrBars[k]!;
        const c = item.candle;

        // ORB (Breakout above OR High)
        if (c.close > orHigh && !brokeHigh) {
          brokeHigh = true;
          candidates.push({
            startIndex: session[0]!.index,
            detectedIndex: item.index,
            subtype: "ORB",
            orientation: "UP",
            openingRangeHigh: orHigh,
            openingRangeLow: orLow,
            openingRangeBps: Number(orBps.toFixed(6)),
            patternHigh: c.high,
            patternLow: orLow,
          });
        }

        // ORB (Breakdown below OR Low)
        if (c.close < orLow && !brokeLow) {
          brokeLow = true;
          candidates.push({
            startIndex: session[0]!.index,
            detectedIndex: item.index,
            subtype: "ORB",
            orientation: "DOWN",
            openingRangeHigh: orHigh,
            openingRangeLow: orLow,
            openingRangeBps: Number(orBps.toFixed(6)),
            patternHigh: orHigh,
            patternLow: c.low,
          });
        }

        // ORB Failure: broke high earlier, but now closes back below OR low
        if (brokeHigh && c.close < orLow) {
          candidates.push({
            startIndex: session[0]!.index,
            detectedIndex: item.index,
            subtype: "ORB_FAILURE",
            orientation: "DOWN",
            openingRangeHigh: orHigh,
            openingRangeLow: orLow,
            openingRangeBps: Number(orBps.toFixed(6)),
            patternHigh: Math.max(...session.slice(0, k + 1).map((s) => s.candle.high)),
            patternLow: c.low,
          });
        }

        // OR Sweep & Rejection: High sweeps above OR high, closes back inside OR
        if (c.high > orHigh && c.close < orHigh && c.close > orLow) {
          candidates.push({
            startIndex: session[0]!.index,
            detectedIndex: item.index,
            subtype: "OPENING_RANGE_SWEEP",
            orientation: "DOWN",
            openingRangeHigh: orHigh,
            openingRangeLow: orLow,
            openingRangeBps: Number(orBps.toFixed(6)),
            patternHigh: c.high,
            patternLow: orLow,
          });
        }

        // OR Low Sweep: Low sweeps below OR low, closes back inside OR
        if (c.low < orLow && c.close > orLow && c.close < orHigh) {
          candidates.push({
            startIndex: session[0]!.index,
            detectedIndex: item.index,
            subtype: "OPENING_RANGE_SWEEP",
            orientation: "UP",
            openingRangeHigh: orHigh,
            openingRangeLow: orLow,
            openingRangeBps: Number(orBps.toFixed(6)),
            patternHigh: orHigh,
            patternLow: c.low,
          });
        }
      }
    };

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(c.openTime.getTime() + istOffsetMs);
      const sessionDateStr = istDate.toISOString().slice(0, 10);

      if (sessionDateStr !== currentSessionDate) {
        if (sessionCandles.length > 0) {
          processSession(sessionCandles);
        }
        sessionCandles = [];
        currentSessionDate = sessionDateStr;
      }
      sessionCandles.push({ candle: c, index: i });
    }

    if (sessionCandles.length > 0) {
      processSession(sessionCandles);
    }

    return candidates;
  }
}
