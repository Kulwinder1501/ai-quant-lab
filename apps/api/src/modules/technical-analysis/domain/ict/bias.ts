import { istSessionDate } from "../../../platform/calendar/trading-session.js";
import type { CausalCandle } from "./causal-pivot.js";
import type { IctStructureSnapshot } from "./structure.js";
import type { SessionLevelsSnapshot } from "./session-levels.js";

export type IctBiasDirection = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
export type DailyPathTemplate = "OLHC" | "OHLC" | "CONSOLIDATION" | "UNKNOWN";

export interface DealingRange {
  readonly rangeHigh: number;
  readonly rangeLow: number;
  readonly equilibrium: number;
  readonly isPremium: (price: number) => boolean;
  readonly isDiscount: (price: number) => boolean;
}

export interface IctBiasSnapshot {
  readonly bias: IctBiasDirection;
  readonly dailyTemplate: DailyPathTemplate;
  readonly dealingRange: DealingRange | null;
  readonly reasons: readonly string[];
}

export class IctBiasTracker {
  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    structure: IctStructureSnapshot,
    sessionLevels: SessionLevelsSnapshot,
    /** Where bias comes from at this level of the fractal chain. See `IctEngineConfig.biasSource`. */
    biasSource: "HIGHER_TIMEFRAME" | "OWN_STRUCTURE",
    /**
     * The higher-timeframe directional read, which is what bias actually IS.
     *
     * Source doctrine (lecture 9, "What Is BIAS"): three institutional levels -- monthly (macro),
     * weekly (intermediate term), daily (short term) -- analysed **monthly to daily**, explicitly
     * not daily to monthly. Bias is the higher-timeframe narrative; the execution timeframe supplies
     * structure and liquidity, never the bias.
     *
     * Absent (or UNKNOWN) means no higher-timeframe evidence, which resolves to UNKNOWN rather than
     * NEUTRAL: missing evidence is not a reading of "no direction".
     */
    htfBias?: IctBiasDirection
  ): IctBiasSnapshot {
    const current = candles[currentIndex];
    const currentDate = sessionLevels.currentSessionDate;
    const reasons: string[] = [];

    // 1. Analyze intraday path (from start of current session)
    let sessionStartIndex = currentIndex;
    while (
      sessionStartIndex > 0 &&
      istSessionDate(candles[sessionStartIndex - 1].openTime) === currentDate
    ) {
      sessionStartIndex--;
    }

    const sessionCandles = candles.slice(sessionStartIndex, currentIndex + 1);
    let dailyTemplate: DailyPathTemplate = "UNKNOWN";

    if (sessionCandles.length >= 3) {
      let highIdx = 0;
      let lowIdx = 0;
      let maxH = -Infinity;
      let minL = Infinity;

      for (let i = 0; i < sessionCandles.length; i++) {
        if (sessionCandles[i].high > maxH) {
          maxH = sessionCandles[i].high;
          highIdx = i;
        }
        if (sessionCandles[i].low < minL) {
          minL = sessionCandles[i].low;
          lowIdx = i;
        }
      }

      if (lowIdx < highIdx) {
        dailyTemplate = "OLHC"; // Open -> Low formed first -> High formed -> Bullish template
      } else if (highIdx < lowIdx) {
        dailyTemplate = "OHLC"; // Open -> High formed first -> Low formed -> Bearish template
      } else {
        dailyTemplate = "CONSOLIDATION";
      }
    }

    // 2. Derive Bias from Structure + Session Liquidity Sweeps
    let bias: IctBiasDirection = "UNKNOWN";

    /*
     * A. A prior-session sweep CONFIRMS the higher-timeframe bias; it never overrides it.
     *
     * It used to override, which contradicted the source doctrine and produced a state the engine
     * should not hold. Lecture 5 is explicit that a sweep's meaning depends on the trend: with the
     * trend, a swept prior-day low gives the full move to the prior-day high ("हाई का पूरा टारगेट
     * है"); against the trend, the same sweep gives only a pop to the nearest untapped POI before
     * the trend resumes. So a bullish sweep under a bearish higher timeframe is not a long -- and
     * letting it set bias BULLISH made exactly that claim.
     */
    const sweep = sessionLevels.lastSweepEvent;
    const sweptDirection: IctBiasDirection | null = sweep && sweep.eventType === "SWEEP"
      ? (sweep.levelType === "PDL" ? "BULLISH" : sweep.levelType === "PDH" ? "BEARISH" : null)
      : null;

    if (sweptDirection !== null && sweptDirection === htfBias) {
      bias = sweptDirection;
      const level = sweptDirection === "BULLISH" ? "Prior Day Low (SSL)" : "Prior Day High (BSL)";
      reasons.push(`${level} swept with the higher-timeframe ${htfBias} bias -> full expansion expected`);
    } else if (sweptDirection !== null) {
      // Recorded, not acted on: a counter-trend sweep is a scalp back to the nearest POI, which
      // this strategy does not trade. Bias stays with the higher timeframe below.
      reasons.push(`Counter-trend ${sweptDirection} sweep against higher-timeframe bias -> not a reversal`);
    }

    /*
     * B. Otherwise the higher-timeframe read IS the bias.
     *
     * This used to fall back to `structure.trend` -- the confirmed trend on the *execution*
     * timeframe. That made the bias pillar a restatement of the structure pillar, and the strategy
     * then gated on the two agreeing, so the gate could not reject anything: measured over 45 days
     * it passed 405 of 405 pillar-aligned BANKNIFTY bars and 646 of 646 on NIFTY50. Two of the four
     * pillars were one measurement.
     *
     * Sourcing bias from the higher timeframe is both what the doctrine says and what makes
     * `bias vs structure.trend` an independent test: a higher-timeframe uptrend against a local
     * downtrend is now a refusal instead of a tautology.
     */
    if (bias === "UNKNOWN") {
      if (biasSource === "OWN_STRUCTURE") {
        /*
         * Top of the fractal chain. Here the swing sequence *is* the price-action read -- lecture 9
         * derives the macro bias from the monthly's own highs and lows ("प्राइस एक्शन बुलिश हाई लो
         * हाई लो") and carries it down. Reading structure at THIS level is correct; reading it at the
         * execution level is the circularity this option exists to separate.
         */
        if (structure.trend === "BULLISH" || structure.trend === "BEARISH") {
          bias = structure.trend;
          reasons.push(`Own swing sequence is ${structure.trend} (top of the fractal chain)`);
        } else if (dailyTemplate === "UNKNOWN") {
          bias = "UNKNOWN";
          reasons.push("Insufficient history to resolve the price-action read -> bias unknown");
        } else {
          bias = "NEUTRAL";
          reasons.push("Price-action read is ranging -> no directional edge");
        }
      } else if (htfBias === "BULLISH" || htfBias === "BEARISH") {
        bias = htfBias;
        reasons.push(`Higher-timeframe bias is ${htfBias} (monthly-to-daily narrative)`);
      } else if (htfBias === "NEUTRAL") {
        // The higher timeframe was resolved and carries no direction. Evidence present, edge absent.
        bias = "NEUTRAL";
        reasons.push("Higher-timeframe read is directionless -> no bias");
      } else {
        // Absent or UNKNOWN. Fails closed: the pillar is uncovered, not neutral.
        bias = "UNKNOWN";
        reasons.push("No higher-timeframe evidence available -> bias unknown");
      }
    }

    // 3. Compute Dealing Range
    let dealingRange: DealingRange | null = null;
    let rangeHigh: number | null = null;
    let rangeLow: number | null = null;

    if (structure.lastHH && structure.lastHL) {
      rangeHigh = structure.lastHH.price;
      rangeLow = structure.lastHL.price;
    } else if (structure.lastLH && structure.lastLL) {
      rangeHigh = structure.lastLH.price;
      rangeLow = structure.lastLL.price;
    } else if (sessionLevels.levels) {
      rangeHigh = sessionLevels.levels.pdh;
      rangeLow = sessionLevels.levels.pdl;
    }

    if (rangeHigh !== null && rangeLow !== null && rangeHigh > rangeLow) {
      const eq = (rangeHigh + rangeLow) / 2;
      dealingRange = {
        rangeHigh,
        rangeLow,
        equilibrium: eq,
        isPremium: (price: number) => price >= eq,
        isDiscount: (price: number) => price < eq,
      };
    }

    return {
      bias,
      dailyTemplate,
      dealingRange,
      reasons,
    };
  }
}
