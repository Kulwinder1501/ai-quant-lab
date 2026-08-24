import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import { buildControlPoints, controlIneligibleReason } from "./research-strategies.js";

/** A whole-minute decision inside the 2026-08-03 session, as UTC. */
function ist(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 7, 3, hour - 5, minute - 30));
}

const sessionCloseAt = ist(15, 30);

/** The full 1m indicator set the three research strategies read, at ta-v1. */
const canonicalIndicators: StrategyMarketContext["indicators"] = [
  { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 6.2 } },
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 24_310 } },
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 24_305 } },
  { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 61 } },
  { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 24_300 } },
  { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { value: 24_280, trend: "UP" } },
];

function context(overrides: Partial<StrategyMarketContext> = {}): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "instrument-1", timeframe: "1m",
      openTime: ist(9, 45), closeTime: ist(9, 46),
      open: 24_308, high: 24_315, low: 24_306, close: 24_312, volume: 1_200, tickSize: 0.05,
    },
    indicators: canonicalIndicators,
    patterns: [],
    priceActionEvents: [],
    ...overrides,
  } as StrategyMarketContext;
}

describe("control point eligibility", () => {
  it("marks a point eligible only when every consumed indicator and both feature layers are there", () => {
    const [long, short] = buildControlPoints(context(), sessionCloseAt, "COMPLETE");

    expect(long!.sampleEligible).toBe(true);
    expect(long!.ineligibleReason).toBeNull();
    expect(short!.sampleEligible).toBe(true);
  });

  it("refuses a point whose pattern layer has not been computed, even with every indicator present", () => {
    // The 2026-08-24 defect. Every indicator was there and canonical ATR was positive, so the old
    // ATR-only rule called all 750 decision points eligible while 46% of the session's evaluations
    // read a bar with no candlestick layer at all. An empty `patterns` array is indistinguishable
    // from a quiet bar, which is exactly why coverage is passed in rather than inferred here.
    const [control] = buildControlPoints(context(), sessionCloseAt, "INCOMPLETE");

    expect(control!.sampleEligible).toBe(false);
    expect(control!.ineligibleReason).toBe("FEATURE_LAYER_NOT_COMPUTED");
  });

  it("names the missing indicators, so a warmup point says which feature it lacked", () => {
    const withoutVwap = context({
      indicators: canonicalIndicators.filter((item) => item.code !== "VWAP" && item.code !== "SUPERTREND"),
    });

    expect(controlIneligibleReason(withoutVwap, "COMPLETE")).toBe("FEATURE_WARMUP:SUPERTREND,VWAP");
  });

  it("reports warmup ahead of coverage when both are missing", () => {
    // Warmup is a property of the bar and no amount of waiting for the detection job repairs it.
    const bare = context({ indicators: [] });

    expect(controlIneligibleReason(bare, "INCOMPLETE")).toMatch(/^FEATURE_WARMUP:/);
  });

  it("still refuses a zero ATR, which the canonical geometry divides by", () => {
    const zeroAtr = context({
      indicators: canonicalIndicators.map((item) => item.code === "ATR" ? { ...item, values: { value: 0 } } : item),
    });

    expect(controlIneligibleReason(zeroAtr, "COMPLETE")).toBe("FEATURE_WARMUP:ATR");
  });

  it("does not accept an indicator from another algorithm version or parameter set", () => {
    // A ta-v2 RSI or a period-9 EMA is a different feature; counting it would let a point claim
    // features the strategies would then fail to find.
    const wrongVersion = context({
      indicators: canonicalIndicators.map((item) => item.code === "RSI" ? { ...item, algorithmVersion: "ta-v2" } : item),
    });
    const wrongPeriod = context({
      indicators: canonicalIndicators.map((item) => (
        item.code === "EMA" && item.parameters.period === 3 ? { ...item, parameters: { period: 9 } } : item
      )),
    });

    expect(controlIneligibleReason(wrongVersion, "COMPLETE")).toBe("FEATURE_WARMUP:RSI");
    expect(controlIneligibleReason(wrongPeriod, "COMPLETE")).toBe("FEATURE_WARMUP:EMA");
  });

  it("writes both directions regardless, so an ineligible minute is still a visible grid point", () => {
    // A hole in the grid biases the matched-control population silently; a row marked ineligible
    // is something a reader can see and filter on.
    const controls = buildControlPoints(context({ indicators: [] }), sessionCloseAt, "INCOMPLETE");

    expect(controls.map((item) => item.evaluationDirection)).toEqual(["LONG", "SHORT"]);
    expect(controls.every((item) => item.sampleEligible === false)).toBe(true);
  });

  it("stamps the V2 policy, so V1 rows cannot be pooled with these", () => {
    const [control] = buildControlPoints(context(), sessionCloseAt, "COMPLETE");

    expect(control!.controlPolicyVersion).toBe("MATCHED_CONTROL_POPULATION_V2:GRID_POLICY_V1");
  });
});
