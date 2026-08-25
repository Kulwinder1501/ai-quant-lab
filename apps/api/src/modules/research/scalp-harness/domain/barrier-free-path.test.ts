import { describe, expect, it } from "vitest";
import {
  barrierFreePathPolicyVersion,
  isCommonEligible,
  walkBarrierFreePath,
  type BarrierFreeHorizonObservation,
  type BarrierFreePathInput,
} from "./barrier-free-path.js";
import type { ResearchPriceCandle } from "./contracts.js";
import { settleResearchPath } from "./settlement.js";

const decisionAt = new Date("2026-08-21T04:30:00.000Z");
const lateSessionClose = new Date(decisionAt.getTime() + 120 * 60_000);

function candle(
  minute: number,
  values: Partial<Pick<ResearchPriceCandle, "open" | "high" | "low" | "close">> = {},
): ResearchPriceCandle {
  const open = values.open ?? 100;
  const close = values.close ?? open;
  return {
    openTime: new Date(decisionAt.getTime() + (minute - 1) * 60_000),
    closeTime: new Date(decisionAt.getTime() + minute * 60_000),
    open,
    high: values.high ?? Math.max(open, close),
    low: values.low ?? Math.min(open, close),
    close,
  };
}

function walk(overrides: Partial<BarrierFreePathInput> = {}) {
  return walkBarrierFreePath({
    direction: "LONG",
    decisionAt,
    referencePrice: 100,
    sessionCloseAt: lateSessionClose,
    horizonsMinutes: [1, 3, 5],
    atr: 2,
    forwardCandles: [],
    ...overrides,
  });
}

const at = (result: { observations: readonly BarrierFreeHorizonObservation[] }, horizon: number) =>
  result.observations.find((observation) => observation.horizonMinutes === horizon)!;

describe("barrier-free path", () => {
  it("carries its own frozen policy version, separate from settlement", () => {
    expect(walk().policyVersion).toBe(barrierFreePathPolicyVersion);
    expect(barrierFreePathPolicyVersion).toBe("BARRIER_FREE_PATH_V1");
  });

  it("emits one observation per requested horizon, in ascending order", () => {
    const result = walk({
      horizonsMinutes: [5, 1, 3],
      forwardCandles: [candle(1), candle(2), candle(3), candle(4), candle(5)],
    });
    expect(result.observations.map((observation) => observation.horizonMinutes)).toEqual([1, 3, 5]);
  });

  /*
   * The load-bearing guarantee.
   *
   * The same path is walked twice: once by settlement with a 1-ATR bracket, which stops out at minute 2,
   * and once by this walker. Settlement is *supposed* to stop there. This walker must keep going and
   * report the +5m recovery, because a study that stops where the bracket stops cannot inform the choice
   * of bracket without circularity. If the two ever agree on the tail, this walker has grown a barrier.
   */
  it("walks through a bar that would have stopped a bracket out", () => {
    const path = [
      candle(1, { open: 100, high: 100.4, low: 99.9, close: 100.2 }),
      candle(2, { open: 100.2, high: 100.3, low: 98.5, close: 98.8 }),
      candle(3, { open: 98.8, high: 99.6, low: 98.7, close: 99.5 }),
      candle(4, { open: 99.5, high: 101.2, low: 99.4, close: 101.0 }),
      candle(5, { open: 101, high: 102.4, low: 100.9, close: 102.2 }),
    ];

    const settled = settleResearchPath({
      subjectType: "CANONICAL_OPPORTUNITY",
      subjectId: "subject",
      geometry: {
        direction: "LONG", entryOrderType: "MARKET_AT_REFERENCE", entryPrice: 100,
        stopLoss: 99, targetPrice: 101.5,
        expiresAt: new Date(decisionAt.getTime() + 5 * 60_000),
        geometryPolicyVersion: "TEST_GEOMETRY_V1",
      },
      decisionAt,
      sessionCloseAt: lateSessionClose,
      forwardCandles: path,
    });
    expect(settled.terminal).toMatchObject({ outcome: "STOP", rMultiple: -1 });

    const result = walk({ forwardCandles: path });
    expect(at(result, 5).status).toBe("COMPLETE");
    // The bracket booked -1R; the path finished +2.2 points. Both are true, and they answer different
    // questions.
    expect(at(result, 5).directionalReturnPoints).toBe(2.2);
    expect(at(result, 5).maePoints).toBe(1.5);
  });

  it("reports returns and excursions in points, bps and ATR", () => {
    const result = walk({
      atr: 2,
      forwardCandles: [candle(1, { high: 101, low: 99.5, close: 100.8 })],
      horizonsMinutes: [1],
    });
    const observation = at(result, 1);
    expect(observation.directionalReturnPoints).toBe(0.8);
    expect(observation.directionalReturnBps).toBe(80);
    expect(observation.directionalReturnAtr).toBe(0.4);
    expect(observation.mfePoints).toBe(1);
    expect(observation.maePoints).toBe(0.5);
    expect(observation.mfeAtr).toBe(0.5);
  });

  it("returns null ATR figures rather than substituting a scale", () => {
    // A NIFTY50 point and a BANKNIFTY point are not the same event; an invented denominator would hide
    // exactly the difference the ATR unit exists to expose.
    const result = walk({
      atr: null,
      forwardCandles: [candle(1, { high: 101, close: 100.8 })],
      horizonsMinutes: [1],
    });
    expect(at(result, 1).directionalReturnAtr).toBeNull();
    expect(at(result, 1).mfeAtr).toBeNull();
    expect(at(result, 1).directionalReturnPoints).toBe(0.8);
  });

  it("normalises sign so positive is favourable on a short", () => {
    const path = [candle(1, { open: 100, high: 100.5, low: 98, close: 98.5 })];
    const long = walk({ direction: "LONG", forwardCandles: path, horizonsMinutes: [1] });
    const short = walk({ direction: "SHORT", forwardCandles: path, horizonsMinutes: [1] });

    expect(at(long, 1).directionalReturnPoints).toBe(-1.5);
    expect(at(short, 1).directionalReturnPoints).toBe(1.5);
    // Favourable and adverse swap with the direction, not just the return's sign.
    expect(at(long, 1).mfePoints).toBe(0.5);
    expect(at(short, 1).mfePoints).toBe(2);
    expect(at(long, 1).maePoints).toBe(2);
    expect(at(short, 1).maePoints).toBe(0.5);
  });

  it("accumulates excursions across horizons and times the first peak", () => {
    const result = walk({
      horizonsMinutes: [1, 3, 5],
      forwardCandles: [
        candle(1, { high: 100.5, low: 99.8, close: 100.3 }),
        candle(2, { high: 101.8, low: 100.2, close: 101.5 }),
        candle(3, { high: 101.8, low: 101.0, close: 101.2 }),
        candle(4, { high: 101.4, low: 99.0, close: 99.2 }),
        candle(5, { high: 99.5, low: 98.0, close: 98.4 }),
      ],
    });
    expect(at(result, 1).mfePoints).toBe(0.5);
    expect(at(result, 3).mfePoints).toBe(1.8);
    // Minute 3 equals minute 2's high without extending it, so the peak stays attributed to minute 2.
    expect(at(result, 3).timeToMfeMinutes).toBe(2);
    expect(at(result, 5).mfePoints).toBe(1.8);
    expect(at(result, 5).maePoints).toBe(2);
    expect(at(result, 5).timeToMaeMinutes).toBe(5);
  });

  it("reports give-back and retention as complements of one another", () => {
    const result = walk({
      horizonsMinutes: [3],
      forwardCandles: [
        candle(1, { high: 100.4, close: 100.3 }),
        candle(2, { high: 102, low: 100.2, close: 101.8 }),
        candle(3, { high: 101.9, low: 100.4, close: 100.5 }),
      ],
    });
    const observation = at(result, 3);
    // Peak +2.0, close +0.5: a quarter retained, three quarters surrendered.
    expect(observation.mfePoints).toBe(2);
    expect(observation.directionalReturnPoints).toBe(0.5);
    expect(observation.retentionRatio).toBe(0.25);
    expect(observation.giveBackRatio).toBe(0.75);
    expect(observation.giveBackRatio! + observation.retentionRatio!).toBeCloseTo(1, 9);
  });

  it("leaves give-back null, not zero, when there was no favourable excursion", () => {
    // Zero would assert a peak existed and none of it was surrendered. Price simply never traded above
    // the reference, which is a different and weaker statement.
    const result = walk({
      horizonsMinutes: [1],
      forwardCandles: [candle(1, { open: 100, high: 100, low: 99, close: 99.2 })],
    });
    expect(at(result, 1).mfePoints).toBe(0);
    expect(at(result, 1).giveBackRatio).toBeNull();
    expect(at(result, 1).retentionRatio).toBeNull();
    expect(at(result, 1).timeToMfeMinutes).toBeNull();
  });

  it("does not clamp a reversal through the reference price", () => {
    // Peak +1.0, close -1.0: retention -1, give-back 2. Clamping would hide that the move reversed
    // through its own starting point, which is precisely the behaviour the 1m thesis is about.
    const result = walk({
      horizonsMinutes: [2],
      forwardCandles: [
        candle(1, { high: 101, low: 99.9, close: 100.8 }),
        candle(2, { high: 100.9, low: 98.9, close: 99 }),
      ],
    });
    expect(at(result, 2).retentionRatio).toBe(-1);
    expect(at(result, 2).giveBackRatio).toBe(2);
  });

  it("spoils only the horizons a data gap actually reaches", () => {
    // Losing the tail of a session should cost the tail of the curve. Settlement has one terminal answer
    // and must abandon the subject; a horizon ladder does not.
    const result = walk({
      horizonsMinutes: [1, 3, 5],
      forwardCandles: [candle(1, { high: 100.6, close: 100.5 }), candle(2), candle(3, { close: 100.4 })],
    });
    expect(at(result, 1).status).toBe("COMPLETE");
    expect(at(result, 3).status).toBe("COMPLETE");
    expect(at(result, 5)).toMatchObject({
      status: "DATA_INCOMPLETE",
      statusReason: "MISSING_1M_CANDLE_AT_MINUTE_4",
      barsObserved: 3,
    });
    expect(at(result, 5).directionalReturnPoints).toBeNull();
  });

  it("defers to the shared session-boundary rule instead of its own", () => {
    // A 30-minute horizon on a decision 10 minutes before the close is ineligible, and it must be
    // ineligible by exactly the same rule settlement uses -- otherwise the two curves stop being
    // comparable at the boundary, which is where boundary-heavy sessions live.
    const result = walk({
      horizonsMinutes: [5, 30],
      sessionCloseAt: new Date(decisionAt.getTime() + 10 * 60_000),
      forwardCandles: Array.from({ length: 30 }, (_, index) => candle(index + 1)),
    });
    expect(at(result, 5).status).toBe("COMPLETE");
    expect(at(result, 30)).toMatchObject({
      status: "INELIGIBLE_SESSION_BOUNDARY",
      statusReason: "SESSION_BOUNDARY",
    });
  });

  it("identifies a common-eligible decision for the secondary curve", () => {
    const complete = walk({
      horizonsMinutes: [1, 3],
      forwardCandles: [candle(1), candle(2), candle(3)],
    });
    expect(isCommonEligible(complete)).toBe(true);

    const truncated = walk({ horizonsMinutes: [1, 3], forwardCandles: [candle(1)] });
    expect(isCommonEligible(truncated)).toBe(false);
  });

  it("rejects horizon ladders that cannot be aggregated", () => {
    expect(() => walk({ horizonsMinutes: [] })).toThrow(/at least one horizon/);
    expect(() => walk({ horizonsMinutes: [1, 1, 3] })).toThrow(/unique/);
    expect(() => walk({ horizonsMinutes: [0] })).toThrow(/positive whole minutes/);
    expect(() => walk({ horizonsMinutes: [2.5] })).toThrow(/positive whole minutes/);
  });

  it("rejects a reference price that cannot normalise a return", () => {
    expect(() => walk({ referencePrice: 0 })).toThrow(/positive reference price/);
    expect(() => walk({ decisionAt: new Date(Number.NaN) })).toThrow(/valid decision time/);
  });

  it("ignores candles at or before the decision", () => {
    // A bar closing on the decision minute is the bar the decision was taken from. Counting its extremes
    // would measure the setup, not the path after it.
    const result = walk({
      horizonsMinutes: [1],
      forwardCandles: [
        { ...candle(0, { high: 105, low: 95, close: 100 }), closeTime: decisionAt },
        candle(1, { high: 100.5, low: 99.7, close: 100.2 }),
      ],
    });
    expect(at(result, 1).mfePoints).toBe(0.5);
    expect(at(result, 1).maePoints).toBe(0.3);
  });
});
