import { describe, expect, it } from "vitest";
import {
  calculateHtfSrConfluence,
  calculateHtfTrendAlignment,
  type HigherTimeframeContext,
} from "./multi-timeframe-confluence.js";

describe("Multi-Timeframe Confluence Scoring", () => {
  it("returns +1 when all directional HTFs agree with signal direction", () => {
    const htfs: HigherTimeframeContext[] = [
      {
        htfTimeframe: "15m",
        trendBias: "BULLISH",
        trendConfidence: 0.8,
        nearestSupportLevel: 24000,
        nearestResistanceLevel: 24500,
        chartPatterns: [],
      },
      {
        htfTimeframe: "60m",
        trendBias: "BULLISH",
        trendConfidence: 0.7,
        nearestSupportLevel: 23800,
        nearestResistanceLevel: 24600,
        chartPatterns: [],
      },
    ];

    expect(calculateHtfTrendAlignment("BULLISH", htfs)).toBe(1);
    expect(calculateHtfTrendAlignment("BEARISH", htfs)).toBe(-1);
  });

  it("returns 0 when HTFs are mixed (e.g. 15m BULLISH, 60m BEARISH)", () => {
    const htfs: HigherTimeframeContext[] = [
      {
        htfTimeframe: "15m",
        trendBias: "BULLISH",
        trendConfidence: 0.8,
        nearestSupportLevel: null,
        nearestResistanceLevel: null,
        chartPatterns: [],
      },
      {
        htfTimeframe: "60m",
        trendBias: "BEARISH",
        trendConfidence: 0.7,
        nearestSupportLevel: null,
        nearestResistanceLevel: null,
        chartPatterns: [],
      },
    ];

    expect(calculateHtfTrendAlignment("BULLISH", htfs)).toBe(0);
    expect(calculateHtfTrendAlignment("BEARISH", htfs)).toBe(0);
  });

  it("returns 0 when HTFs are all NEUTRAL or missing", () => {
    const neutralHtfs: HigherTimeframeContext[] = [
      {
        htfTimeframe: "15m",
        trendBias: "NEUTRAL",
        trendConfidence: 0.5,
        nearestSupportLevel: null,
        nearestResistanceLevel: null,
        chartPatterns: [],
      },
    ];

    expect(calculateHtfTrendAlignment("BULLISH", neutralHtfs)).toBe(0);
    expect(calculateHtfTrendAlignment("BULLISH", [])).toBe(0);
    expect(calculateHtfTrendAlignment("BULLISH", undefined)).toBe(0);
  });

  it("calculates HTF S/R confluence within ATR tolerance", () => {
    const htfs: HigherTimeframeContext[] = [
      {
        htfTimeframe: "15m",
        trendBias: "BULLISH",
        trendConfidence: 0.8,
        nearestSupportLevel: 24000,
        nearestResistanceLevel: 24200,
        chartPatterns: [],
      },
    ];

    const atr = 20; // maxDistanceAtr default is 1.5 -> tolerance is 30

    // Price is 24015 (within 15 of 24000 support, tolerance 30) -> +1 for BULLISH
    expect(calculateHtfSrConfluence(24015, "BULLISH", atr, htfs)).toBe(1);

    // Price is 24050 (50 away from support, > 30) -> 0 for BULLISH
    expect(calculateHtfSrConfluence(24050, "BULLISH", atr, htfs)).toBe(0);

    // Price is 24190 (within 10 of 24200 resistance, tolerance 30) -> +1 for BEARISH
    expect(calculateHtfSrConfluence(24190, "BEARISH", atr, htfs)).toBe(1);
  });
});
