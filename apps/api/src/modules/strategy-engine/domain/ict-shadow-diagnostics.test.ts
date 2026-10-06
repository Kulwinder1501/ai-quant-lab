import { describe, expect, it } from "vitest";
import { computeIctShadowDiagnostics } from "./ict-shadow-diagnostics.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import type { LiquidityPool } from "../../technical-analysis/domain/ict/liquidity.js";
import type { ConfirmedPivot } from "../../technical-analysis/domain/ict/causal-pivot.js";

function makePivot(price: number, type: "HIGH" | "LOW"): ConfirmedPivot {
  const time = new Date("2026-10-01T00:00:00.000Z");
  return { index: 0, time, price, type, confirmedAtIndex: 3, confirmedAtTime: time, availableAt: time.getTime() };
}

// Minimal fully-typed fixture, same convention as feature-extraction.test.ts's own makeSnapshot:
// only the fields computeIctShadowDiagnostics reads are varied per test.
function makeSnapshot(overrides: {
  readonly trend?: IctStateCompositeSnapshot["structure"]["trend"];
  readonly swingHierarchy?: IctStateCompositeSnapshot["swingHierarchy"];
  readonly primaryTarget?: LiquidityPool | null;
  readonly selectedPool?: LiquidityPool | null;
}): IctStateCompositeSnapshot {
  return {
    engineVersion: "ict-state-v2",
    configHash: "x".repeat(64),
    barIndex: 0,
    barTime: new Date("2026-10-05T10:00:00.000Z"),
    atr14: null,
    structure: {
      trend: overrides.trend ?? "NEUTRAL",
      lastHH: null, lastHL: null, lastLL: null, lastLH: null,
      idm: null, bosLevel: null, chochLevel: null,
      internalVsExternal: "EXTERNAL", lastEvent: null, confirmedPivotCount: 0,
    },
    swingHierarchy: overrides.swingHierarchy ?? {
      nearestIntermediateTermHigh: null,
      nearestIntermediateTermLow: null,
      nearestShortTermHigh: null,
      nearestShortTermLow: null,
    },
    cisd: null,
    balancedPriceRanges: [],
    zones: { activeFvgs: [], activeObs: [], lastZoneEvent: null },
    sessionLevels: {
      levels: null, lastSweepEvent: null,
      currentSessionHigh: 0, currentSessionLow: 0, currentSessionOpen: 0,
      currentSessionDate: "2026-10-05",
    },
    bias: { bias: "NEUTRAL", dailyTemplate: "UNKNOWN", dealingRange: null, reasons: [] },
    liquidity: {
      erlPoolCount: 0, irlPoolCount: 0,
      primaryTarget: overrides.primaryTarget ?? null,
      intermediateTarget: null, invalidationLevel: null,
      alignmentStatus: "BLOCKED_MISSING_PILLAR", rationale: "",
    },
    htfBias: null,
    coverage: {
      structure: "UNKNOWN", zones: "COMPLETE", sessionLevels: "NOT_COVERED",
      bias: "UNKNOWN", liquidity: "NOT_COVERED", htf: "NOT_COVERED",
    },
    drawOnLiquidityState: {
      selectedPool: overrides.selectedPool ?? null,
      candidatePoolCount: overrides.selectedPool ? 1 : 0,
      direction: 0,
      selectionRuleVersion: "LIQUIDITY_TARGET_SELECTION_V1",
    },
  };
}

function pool(overrides: Partial<LiquidityPool> & Pick<LiquidityPool, "id" | "kind" | "price">): LiquidityPool {
  return { isMitigated: false, ...overrides };
}

describe("computeIctShadowDiagnostics", () => {
  it("reports PROTECTED when the ITL is intact under a bullish trend", () => {
    const snapshot = makeSnapshot({
      trend: "BULLISH",
      swingHierarchy: {
        nearestIntermediateTermHigh: null,
        nearestIntermediateTermLow: makePivot(100, "LOW"),
        nearestShortTermHigh: null,
        nearestShortTermLow: null,
      },
    });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 110, new Date());
    expect(diagnostics.protectedStatusAtCutoff).toBe("PROTECTED");
    expect(diagnostics.protectedLevelBreached).toBe(false);
    expect(diagnostics.swingHierarchyPresent).toBe(true);
  });

  it("reports BREACHED when price has closed beyond the protected ITL", () => {
    const snapshot = makeSnapshot({
      trend: "BULLISH",
      swingHierarchy: {
        nearestIntermediateTermHigh: null,
        nearestIntermediateTermLow: makePivot(100, "LOW"),
        nearestShortTermHigh: null,
        nearestShortTermLow: null,
      },
    });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 95, new Date());
    expect(diagnostics.protectedStatusAtCutoff).toBe("BREACHED");
    expect(diagnostics.protectedLevelBreached).toBe(true);
  });

  it("reports UNKNOWN and swingHierarchyPresent=false before any Intermediate Term point has formed", () => {
    const snapshot = makeSnapshot({ trend: "BULLISH" });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 100, new Date());
    expect(diagnostics.protectedStatusAtCutoff).toBe("UNKNOWN");
    expect(diagnostics.swingHierarchyPresent).toBe(false);
  });

  it("flags staleMacroTarget when the resolver's target and the DOL selection disagree", () => {
    const snapshot = makeSnapshot({
      primaryTarget: pool({ id: "erl-pdh-1", kind: "ERL_PDH", price: 200 }),
      selectedPool: pool({ id: "erl-swing-high-7", kind: "ERL_SWING_HIGH", price: 195 }),
    });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 150, new Date());
    expect(diagnostics.staleMacroTarget).toBe(true);
    expect(diagnostics.primaryTargetPrice).toBe(200);
    expect(diagnostics.drawOnLiquidityPrice).toBe(195);
  });

  it("does not flag staleMacroTarget when both selections agree (same pool id)", () => {
    const shared = pool({ id: "erl-pdh-1", kind: "ERL_PDH", price: 200 });
    const snapshot = makeSnapshot({ primaryTarget: shared, selectedPool: shared });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 150, new Date());
    expect(diagnostics.staleMacroTarget).toBe(false);
  });

  it("leaves staleMacroTarget null when either side has no candidate", () => {
    const snapshot = makeSnapshot({ primaryTarget: null, selectedPool: null });
    const diagnostics = computeIctShadowDiagnostics(snapshot, 150, new Date());
    expect(diagnostics.staleMacroTarget).toBeNull();
  });

  it("leaves sessionDateMismatch null when no symbol is supplied", () => {
    const snapshot = makeSnapshot({});
    const diagnostics = computeIctShadowDiagnostics(snapshot, 100, new Date("2026-10-05T17:30:00.000Z"));
    expect(diagnostics.sessionDateMismatch).toBeNull();
  });

  it("flags sessionDateMismatch for a bar in the gap between IST's and NY's own rollovers", () => {
    // 2026-10-07T20:00:00Z: NY is on EDT (UTC-4) in October, so this is 16:00 NY -- before
    // XAUUSD_OANDA_PROFILE's 18:00 NY rollover, so it resolves to the SAME calendar day
    // (2026-10-07). NSE_IST_PROFILE is a fixed +5:30 shift with no rollover rule at all, so the
    // same instant is already 01:30 IST the NEXT day (2026-10-08). The two profiles disagree
    // precisely in this gap, which is the real-world case G1 existed to fix for gold.
    const instant = new Date("2026-10-07T20:00:00.000Z");
    const snapshot = makeSnapshot({});
    const diagnostics = computeIctShadowDiagnostics(snapshot, 100, instant, "XAU_USD");
    expect(diagnostics.sessionDateMismatch).toBe(true);
  });

  it("does not flag sessionDateMismatch for an NSE symbol (its own profile is the comparison baseline)", () => {
    const snapshot = makeSnapshot({});
    const diagnostics = computeIctShadowDiagnostics(snapshot, 100, new Date("2026-10-05T05:00:00.000Z"), "NIFTY50");
    expect(diagnostics.sessionDateMismatch).toBe(false);
  });
});
