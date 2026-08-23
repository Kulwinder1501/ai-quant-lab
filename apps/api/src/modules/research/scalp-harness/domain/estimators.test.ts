import { describe, expect, it } from "vitest";
import {
  cohortKeyOf,
  estimateGateValue,
  estimateNativePolicyEdge,
  estimateSignalEdge,
  partitionByCohort,
  summariseByDayBootstrap,
  type SignalEdgeUnit,
} from "./estimators.js";

function signalUnit(overrides: Partial<SignalEdgeUnit> & { sessionId: string }): SignalEdgeUnit {
  return {
    opportunityId: `opp-${overrides.sessionId}`,
    strategyDefinitionHashes: ["cohort-a"],
    selectedOutcomeR: 1,
    controlOutcomesR: [0, 0, 0, 0, 0],
    ...overrides,
  };
}

describe("signal edge", () => {
  it("differences the treated outcome against the mean of its five controls", () => {
    const result = estimateSignalEdge([
      signalUnit({ sessionId: "2026-08-03", selectedOutcomeR: 1.5, controlOutcomesR: [0.5, 0.5, 0.5, 0.5, 0.5] }),
    ]);
    expect(result.units).toBe(1);
    expect(result.meanPerUnit).toBeCloseTo(1.0, 10);
    // A single day cannot express between-day variance, so no interval is fabricated.
    expect(result.ci95).toBeNull();
  });

  it("excludes a unit whose controls are not all gradeable, rather than averaging a smaller baseline", () => {
    // A partly-settled control set would measure this unit against a different baseline than its peers.
    const result = estimateSignalEdge([
      signalUnit({ sessionId: "2026-08-03", controlOutcomesR: [0, 0, null, 0, 0] }),
      signalUnit({ sessionId: "2026-08-04", selectedOutcomeR: null }),
      signalUnit({ sessionId: "2026-08-05" }),
    ]);
    expect(result.units).toBe(1);
    expect(result.excludedUnits).toBe(2);
  });

  it("weights days equally, so one busy day cannot dominate the estimate", () => {
    // Day A carries four units at +1; day B a single unit at -1. Per-unit mean would be +0.6;
    // the per-day statistic is 0, which is what the interval is built from.
    const units = [
      ...Array.from({ length: 4 }, (_, index) => signalUnit({
        sessionId: "2026-08-03", opportunityId: `busy-${index}`, selectedOutcomeR: 1,
      })),
      signalUnit({ sessionId: "2026-08-04", selectedOutcomeR: -1 }),
    ];
    const result = estimateSignalEdge(units);
    expect(result.meanPerUnit).toBeCloseTo(0.6, 10);
    expect(result.meanPerDay).toBeCloseTo(0, 10);
  });

  it("is reproducible: identical rows produce an identical interval", () => {
    const units = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"].map((sessionId, index) =>
      signalUnit({ sessionId, selectedOutcomeR: index % 2 === 0 ? 1 : 0.5 }));
    const first = estimateSignalEdge(units);
    const second = estimateSignalEdge(units);
    expect(first.ci95).toEqual(second.ci95);
    expect(first.ci95).not.toBeNull();
  });

  it("brackets zero for a no-edge sample and stays above zero for a strong one", () => {
    const days = Array.from({ length: 12 }, (_, index) => `2026-08-${String(index + 3).padStart(2, "0")}`);
    const noEdge = estimateSignalEdge(days.map((sessionId, index) =>
      signalUnit({ sessionId, selectedOutcomeR: index % 2 === 0 ? 0.4 : -0.4 })));
    expect(noEdge.ci95!.lower).toBeLessThan(0);
    expect(noEdge.ci95!.upper).toBeGreaterThan(0);

    const strong = estimateSignalEdge(days.map((sessionId) => signalUnit({ sessionId, selectedOutcomeR: 1 })));
    expect(strong.ci95!.lower).toBeGreaterThan(0);
  });
});

describe("native execution policy edge", () => {
  it("pairs native against canonical on the same subject", () => {
    const result = estimateNativePolicyEdge([
      { subjectId: "a", sessionId: "2026-08-03", strategyDefinitionHashes: ["cohort-a"], nativeOutcomeR: 1.2, canonicalOutcomeR: 1.0 },
      { subjectId: "b", sessionId: "2026-08-04", strategyDefinitionHashes: ["cohort-a"], nativeOutcomeR: 0.8, canonicalOutcomeR: 1.0 },
    ]);
    expect(result.units).toBe(2);
    expect(result.meanPerDay).toBeCloseTo(0, 10);
  });

  it("drops a pair when either side is ungradeable", () => {
    const result = estimateNativePolicyEdge([
      { subjectId: "a", sessionId: "2026-08-03", strategyDefinitionHashes: ["cohort-a"], nativeOutcomeR: null, canonicalOutcomeR: 1 },
      { subjectId: "b", sessionId: "2026-08-03", strategyDefinitionHashes: ["cohort-a"], nativeOutcomeR: 1, canonicalOutcomeR: null },
    ]);
    expect(result.units).toBe(0);
    expect(result.excludedUnits).toBe(2);
    expect(result.meanPerDay).toBeNull();
  });
});

describe("gate value", () => {
  it("segments outcomes by verdict and labels the result non-causal", () => {
    const result = estimateGateValue([
      { subjectId: "a", sessionId: "2026-08-03", strategyDefinitionHashes: ["cohort-a"], outcomeR: 1, decision: "ALLOW" },
      { subjectId: "b", sessionId: "2026-08-04", strategyDefinitionHashes: ["cohort-a"], outcomeR: -1, decision: "REJECT" },
    ]);
    expect(result.allow.units).toBe(1);
    expect(result.reject.units).toBe(1);
    expect(result.difference).toBeCloseTo(2, 10);
    // The label must travel with the number; the groups were never randomised.
    expect(result.interpretation).toContain("OBSERVATIONAL_NON_CAUSAL");
  });
});

describe("strategy-definition cohorts", () => {
  it("refuses to average a gated and an ungated population into one estimate", () => {
    // Storage-level version immutability is defeated the moment two definitions are pooled: the mean
    // describes a selection rule that never ran. A throw, not a warning — a pooled number looks
    // entirely normal in a report, so a soft signal would be read straight past.
    expect(() => estimateSignalEdge([
      signalUnit({ sessionId: "2026-08-03", strategyDefinitionHashes: ["gated-hash"] }),
      signalUnit({ sessionId: "2026-08-04", strategyDefinitionHashes: ["ungated-hash"] }),
    ])).toThrow(/cohorts/);
  });

  it("partitions a mixed set so each cohort can be estimated on its own", () => {
    const mixed = [
      signalUnit({ sessionId: "2026-08-03", strategyDefinitionHashes: ["gated-hash"] }),
      signalUnit({ sessionId: "2026-08-04", strategyDefinitionHashes: ["ungated-hash"] }),
      signalUnit({ sessionId: "2026-08-05", strategyDefinitionHashes: ["ungated-hash"] }),
    ];
    const cohorts = partitionByCohort(mixed);
    expect([...cohorts.keys()].sort()).toEqual(["gated-hash", "ungated-hash"]);
    expect(cohorts.get("ungated-hash")).toHaveLength(2);
    for (const units of cohorts.values()) expect(() => estimateSignalEdge(units)).not.toThrow();
  });

  it("treats a definition set as one cohort regardless of hash order", () => {
    // An opportunity groups whichever strategies fired at that decision point, so the same pair
    // arriving in a different order must not look like a second cohort.
    expect(cohortKeyOf({ strategyDefinitionHashes: ["b", "a"] }))
      .toBe(cohortKeyOf({ strategyDefinitionHashes: ["a", "b"] }));
  });
});

describe("day-clustered bootstrap", () => {
  it("returns no interval below two days, and one above", () => {
    expect(summariseByDayBootstrap([{ sessionId: "2026-08-03", value: 1 }], 0).ci95).toBeNull();
    const two = summariseByDayBootstrap(
      [{ sessionId: "2026-08-03", value: 1 }, { sessionId: "2026-08-04", value: 1 }], 0,
    );
    expect(two.ci95).not.toBeNull();
  });
});
