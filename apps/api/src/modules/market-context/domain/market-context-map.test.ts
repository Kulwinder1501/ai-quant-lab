import { describe, expect, it } from "vitest";
import {
  BREAK_ACCEPTANCE_BARS,
  OPENING_RANGE_MINUTES,
  buildMarketContextMap,
  marketContextStampBody,
  shadowVetoReasons,
  trendSliceFromIndicators,
  type ContextBar,
} from "./market-context-map.js";

/** 09:15 IST on 2026-10-13 = 03:45 UTC. */
function barAt(utcHour: number, utcMinute: number, ohlc: {
  open: number;
  high: number;
  low: number;
  close: number;
}): ContextBar {
  return {
    openTime: new Date(Date.UTC(2026, 9, 13, utcHour, utcMinute, 0)),
    open: ohlc.open,
    high: ohlc.high,
    low: ohlc.low,
    close: ohlc.close,
    volume: 100,
  };
}

function flatSession(mid: number, count: number): ContextBar[] {
  const bars: ContextBar[] = [];
  // Start 03:45 UTC = 09:15 IST
  for (let i = 0; i < count; i += 1) {
    const minute = 45 + i;
    const hour = 3 + Math.floor(minute / 60);
    const m = minute % 60;
    bars.push(barAt(hour, m, {
      open: mid,
      high: mid + 5,
      low: mid - 5,
      close: mid,
    }));
  }
  return bars;
}

describe("trendSliceFromIndicators", () => {
  it("soft OR and strict AND", () => {
    const softOnly = trendSliceFromIndicators({ price: 100, ema: 99, supertrendUp: false });
    expect(softOnly.soft).toBe("MIXED");
    expect(softOnly.strict).toBe("MIXED");

    const bothUp = trendSliceFromIndicators({ price: 100, ema: 99, supertrendUp: true });
    expect(bothUp.soft).toBe("UP");
    expect(bothUp.strict).toBe("UP");
  });
});

describe("buildMarketContextMap", () => {
  it("reads session high/low and opening range from IST RTH bars", () => {
    const bars = flatSession(22_500, OPENING_RANGE_MINUTES + 10);
    bars[2] = { ...bars[2]!, high: 22_600 };
    bars[20] = { ...bars[20]!, low: 22_400 };
    const map = buildMarketContextMap({
      sessionBars: bars,
      priorSessionBars: flatSession(22_450, 50).map((b) => ({
        ...b,
        openTime: new Date(b.openTime.getTime() - 86_400_000),
      })),
      atr: 20,
      price: 22_500,
      direction: "LONG",
      sessionDateIst: "2026-10-13",
    });

    expect(map.dataQuality).toBe("PASS");
    expect(map.levels.sessionHigh).toBe(22_600);
    expect(map.levels.sessionLow).toBe(22_400);
    expect(map.levels.openingRangeHigh).toBeGreaterThan(0);
    expect(map.levels.priorDayHigh).toBeGreaterThan(0);
  });

  it("marks LONG at resistance for shadow veto when not BREAK", () => {
    const reasons = shadowVetoReasons({
      direction: "LONG",
      location: "AT_RESISTANCE",
      hypothesis: "AMBIGUOUS",
      htfAgreement: "AGREE",
    });
    expect(reasons).toContain("LONG_AT_RESISTANCE");
    expect(reasons).toContain("AMBIGUOUS_AT_LEVEL");

    // End-to-end: price parked under a swing resistance inside the session range.
    const bars = flatSession(22_500, 10).map((b) => ({
      ...b,
      high: 22_505,
      low: 22_495,
      close: 22_500,
      open: 22_500,
    }));
    const map = buildMarketContextMap({
      sessionBars: bars,
      priorSessionBars: [],
      atr: 50,
      price: 22_502,
      direction: "LONG",
      swingLevels: [{ kind: "RESISTANCE", level: 22_504 }],
      sessionDateIst: "2026-10-13",
    });
    expect(map.location).toBe("AT_RESISTANCE");
    expect(map.vetoReasons.length).toBeGreaterThan(0);
  });

  it("does not veto LONG at resistance when hypothesis is BREAK", () => {
    const bars: ContextBar[] = [];
    const level = 22_500;
    for (let i = 0; i < BREAK_ACCEPTANCE_BARS + 5; i += 1) {
      const minute = 45 + i;
      bars.push(barAt(3 + Math.floor(minute / 60), minute % 60, {
        open: level + 10,
        high: level + 20,
        low: level + 5,
        close: level + 15,
      }));
    }
    const map = buildMarketContextMap({
      sessionBars: bars,
      priorSessionBars: [],
      atr: 10,
      price: level + 15,
      direction: "LONG",
      swingLevels: [{ kind: "RESISTANCE", level }],
      sessionDateIst: "2026-10-13",
    });

    expect(map.hypothesis).toBe("BREAK");
    expect(map.vetoReasons).not.toContain("LONG_AT_RESISTANCE");
  });

  it("flags HTF_DISAGREE for LONG when soft biases are DOWN", () => {
    const reasons = shadowVetoReasons({
      direction: "LONG",
      location: "FAR",
      hypothesis: "AMBIGUOUS",
      htfAgreement: "DISAGREE",
    });
    expect(reasons).toEqual(["HTF_DISAGREE"]);
  });

  it("stamp body carries wouldBlock and algorithm version", () => {
    const map = buildMarketContextMap({
      sessionBars: flatSession(55_000, 40),
      priorSessionBars: [],
      atr: 50,
      price: 55_000,
      direction: "SHORT",
      sessionDateIst: "2026-10-13",
    });
    const body = marketContextStampBody(map);
    expect(body.v).toBe("mkt-ctx-v1");
    expect(typeof body.wouldBlock).toBe("boolean");
    expect(body.sentence).toEqual(expect.any(String));
  });
});
