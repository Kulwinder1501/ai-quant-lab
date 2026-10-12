import { describe, expect, it } from "vitest";
import { computeCandidateLevels } from "./levels.js";
import { buildDeterministicBaselines, giftChangeFrom, snapshotHasPrimaryDriver, type MarketSnapshot } from "./snapshot.js";

describe("computeCandidateLevels", () => {
  it("derives prior-day, pivot and multi-session levels from completed bars only", () => {
    const levels = computeCandidateLevels("NIFTY50", [
      { high: 22400, low: 22200, close: 22300 },
      { high: 22700, low: 22500, close: 22600 },
    ]);
    const price = (key: string) => levels.find((l) => l.id === `level-nifty50-${key}`)?.price;
    expect(price("pdh")).toBe(22700);
    expect(price("pdl")).toBe(22500);
    expect(price("pdc")).toBe(22600);
    expect(price("pivot")).toBe(22600);          // (22700+22500+22600)/3
    expect(price("r1")).toBe(22700);             // 2*22600 - 22500
    expect(price("s1")).toBe(22500);             // 2*22600 - 22700
    expect(price("range-high")).toBe(22700);
    expect(price("range-low")).toBe(22200);
  });

  it("returns nothing without a prior session and omits the range with only one", () => {
    expect(computeCandidateLevels("BANKNIFTY", [])).toEqual([]);
    const one = computeCandidateLevels("BANKNIFTY", [{ high: 55000, low: 54000, close: 54500 }]);
    expect(one.some((l) => l.id.endsWith("range-high"))).toBe(false);
    expect(one.every((l) => l.instrument === "BANKNIFTY")).toBe(true);
  });
});

describe("buildDeterministicBaselines", () => {
  it("applies each instrument's own gap threshold to the GIFT change", () => {
    const b = buildDeterministicBaselines(0.3); // above NIFTY's 0.25, below BANKNIFTY's 0.35
    expect(b.NIFTY50.OPENING_GAP.GIFT_THRESHOLD).toBe("UP");
    expect(b.BANKNIFTY.OPENING_GAP.GIFT_THRESHOLD).toBe("FLAT");
  });

  it("gives intraday targets a follow-the-gap and an always-flat baseline", () => {
    const b = buildDeterministicBaselines(-0.5);
    expect(b.NIFTY50.FIRST_60_MINUTES).toEqual({ FOLLOW_GAP: "DOWN", ALWAYS_FLAT: "FLAT" });
    expect(b.BANKNIFTY.FULL_SESSION).toEqual({ FOLLOW_GAP: "DOWN", ALWAYS_FLAT: "FLAT" });
  });

  it("cannot predict from a missing driver, except the constant baseline", () => {
    const b = buildDeterministicBaselines(null);
    expect(b.NIFTY50.OPENING_GAP.GIFT_THRESHOLD).toBeNull();
    expect(b.NIFTY50.FIRST_60_MINUTES.FOLLOW_GAP).toBeNull();
    expect(b.NIFTY50.FIRST_60_MINUTES.ALWAYS_FLAT).toBe("FLAT");
  });
});

describe("primary driver", () => {
  const snapshot = (value: number | null): MarketSnapshot => ({
    sessionDate: "2026-10-12", runSlot: "x", capturedAt: "t", candidateLevels: [],
    evidence: [{ id: "market-evidence-001", category: "GIFT_NIFTY", label: "g", value, unit: "PERCENT_CHANGE", observedAt: null, source: "NSE_IX" }],
  });
  it("is the GIFT Nifty percent change, and a null value does not count", () => {
    expect(snapshotHasPrimaryDriver(snapshot(0.2))).toBe(true);
    expect(giftChangeFrom(snapshot(0.2))).toBe(0.2);
    expect(snapshotHasPrimaryDriver(snapshot(null))).toBe(false);
  });
  it("is absent when only other cues exist", () => {
    const s = snapshot(0.2);
    s.evidence[0]!.category = "ASIAN_INDEX";
    expect(snapshotHasPrimaryDriver(s)).toBe(false);
  });
});
