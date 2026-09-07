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
    const [long, short] = buildControlPoints(context(), sessionCloseAt, "COMPLETE", "LIVE");

    expect(long!.sampleEligible).toBe(true);
    expect(long!.ineligibleReason).toBeNull();
    expect(short!.sampleEligible).toBe(true);
  });

  it("refuses a point whose pattern layer has not been computed, even with every indicator present", () => {
    // The 2026-08-24 defect. Every indicator was there and canonical ATR was positive, so the old
    // ATR-only rule called all 750 decision points eligible while 46% of the session's evaluations
    // read a bar with no candlestick layer at all. An empty `patterns` array is indistinguishable
    // from a quiet bar, which is exactly why coverage is passed in rather than inferred here.
    const [control] = buildControlPoints(context(), sessionCloseAt, "INCOMPLETE", "LIVE");

    expect(control!.sampleEligible).toBe(false);
    expect(control!.ineligibleReason).toBe("FEATURE_LAYER_NOT_COMPUTED");
  });

  it("names the missing indicators, so a warmup point says which feature it lacked", () => {
    const withoutVwap = context({
      indicators: canonicalIndicators.filter((item) => item.code !== "VWAP" && item.code !== "SUPERTREND"),
    });

    expect(controlIneligibleReason(withoutVwap, "COMPLETE", "LIVE")).toBe("FEATURE_WARMUP:SUPERTREND,VWAP");
  });

  it("reports warmup ahead of coverage when both are missing", () => {
    // Warmup is a property of the bar and no amount of waiting for the detection job repairs it.
    const bare = context({ indicators: [] });

    expect(controlIneligibleReason(bare, "INCOMPLETE", "LIVE")).toMatch(/^FEATURE_WARMUP:/);
  });

  it("still refuses a zero ATR, which the canonical geometry divides by", () => {
    const zeroAtr = context({
      indicators: canonicalIndicators.map((item) => item.code === "ATR" ? { ...item, values: { value: 0 } } : item),
    });

    expect(controlIneligibleReason(zeroAtr, "COMPLETE", "LIVE")).toBe("FEATURE_WARMUP:ATR");
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

    expect(controlIneligibleReason(wrongVersion, "COMPLETE", "LIVE")).toBe("FEATURE_WARMUP:RSI");
    expect(controlIneligibleReason(wrongPeriod, "COMPLETE", "LIVE")).toBe("FEATURE_WARMUP:EMA");
  });

  it("writes both directions regardless, so an ineligible minute is still a visible grid point", () => {
    // A hole in the grid biases the matched-control population silently; a row marked ineligible
    // is something a reader can see and filter on.
    const controls = buildControlPoints(context({ indicators: [] }), sessionCloseAt, "INCOMPLETE", "LIVE");

    expect(controls.map((item) => item.evaluationDirection)).toEqual(["LONG", "SHORT"]);
    expect(controls.every((item) => item.sampleEligible === false)).toBe(true);
  });

  it("refuses a point whose bar repeated the previous print", () => {
    /*
     * The 15:16-to-close index freeze. Every indicator is present and both feature layers are
     * computed, so every other gate passes -- the bar is complete, on grid, and correctly stamped.
     * What it is not is an observation of a market event, and `GRID_POLICY_V1` admits fourteen such
     * slots a session.
     */
    const [long, short] = buildControlPoints(context(), sessionCloseAt, "COMPLETE", "FROZEN");

    expect(long!.sampleEligible).toBe(false);
    expect(long!.ineligibleReason).toBe("TAPE_FROZEN");
    expect(short!.ineligibleReason).toBe("TAPE_FROZEN");
  });

  it("reports a frozen tape ahead of a warmup gap", () => {
    // A bar that never moved has no features to be missing. The two do not co-occur in the data that
    // motivated this -- the freeze runs six hours after warmup -- but the precedence is fixed so the
    // single returned reason is deterministic.
    const bare = context({ indicators: [] });

    expect(controlIneligibleReason(bare, "INCOMPLETE", "FROZEN")).toBe("TAPE_FROZEN");
  });

  it("carries no bar count in the reason, so the string does not vary with the query window", () => {
    // `identicalBars` is bounded by how many bars the caller fetched, which makes it a property of
    // the lookback rather than of the bar. Estimators group on this string and live/backfill parity
    // compares it, so it has to be stable.
    expect(controlIneligibleReason(context(), "COMPLETE", "FROZEN")).toBe("TAPE_FROZEN");
  });

  it("stamps the V3 policy, so V1 and V2 rows cannot be pooled with these", () => {
    const [control] = buildControlPoints(context(), sessionCloseAt, "COMPLETE", "LIVE");

    expect(control!.controlPolicyVersion).toBe("MATCHED_CONTROL_POPULATION_V3:GRID_POLICY_V1");
  });
});
