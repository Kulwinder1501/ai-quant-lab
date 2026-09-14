import { describe, expect, it } from "vitest";
import {
  agrees,
  assertComparable,
  classificationOf,
  DifferentialTestingError,
  evaluateDifferentialRun,
  isDecisive,
  promotionBlocker,
  type ClassifiedDivergence,
  type DifferentialObservation,
  type DivergenceEvidence,
} from "./differential-testing.js";

const SNAPSHOT = "snap-a1b2c3";

function observation(overrides: Partial<DifferentialObservation> = {}): DifferentialObservation {
  return {
    comparisonKey: "NIFTY50@2026-09-02T09:20:00Z",
    legacySnapshotRef: SNAPSHOT,
    v2SnapshotRef: SNAPSHOT,
    legacyOutcome: "APPROVED",
    v2Outcome: "APPROVED",
    ...overrides,
  };
}

function divergence(evidence: DivergenceEvidence, overrides: Partial<DifferentialObservation> = {}): ClassifiedDivergence {
  return { observation: observation({ v2Outcome: "REJECTED", ...overrides }), evidence };
}

describe("identical sealed snapshots", () => {
  it("refuses a comparison whose sides read different snapshots", () => {
    /*
     * The load-bearing invariant. §6 requires *identical* sealed snapshots, because if the two sides
     * saw different worlds then any difference in their answers is uninterpretable -- it could be the
     * architecture, or it could be the input.
     */
    expect(() => assertComparable(observation({ v2SnapshotRef: "snap-different" })))
      .toThrow(DifferentialTestingError);
    expect(() => assertComparable(observation({ v2SnapshotRef: "snap-different" })))
      .toThrow(/read different snapshots/);
  });

  it("says explicitly that a mismatched snapshot is not a DATA_DIFFERENCE", () => {
    // The category it would otherwise be filed under, which would make the non-comparison look
    // classified and therefore acceptable.
    expect(() => assertComparable(observation({ v2SnapshotRef: "snap-different" })))
      .toThrow(/not a DATA_DIFFERENCE/);
  });

  it("refuses a comparison that does not record a snapshot at all", () => {
    // An unrecorded snapshot cannot be shown to be the same one, so absence is not permission.
    expect(() => assertComparable(observation({ legacySnapshotRef: "  " })))
      .toThrow(/must cite the sealed snapshot/);
  });

  it("treats matching outcomes on one snapshot as agreement, not divergence", () => {
    expect(agrees(observation())).toBe(true);
    expect(agrees(observation({ v2Outcome: "REJECTED" }))).toBe(false);
  });
});

describe("classification is structural, not free text", () => {
  it("carries the specific evidence each meaning requires", () => {
    /*
     * §6: "formally classified -- not just explained with a free-text reason". A
     * `{ classification, reason }` pair would not satisfy that, because `reason` accepts anything and
     * every divergence could be waved through. Dismissing one as POLICY_DIFFERENCE costs two policy
     * versions that actually differ.
     */
    expect(classificationOf(divergence({
      kind: "POLICY_DIFFERENCE", legacyPolicyVersion: "RISK_V1", v2PolicyVersion: "RISK_V2",
    }))).toBe("POLICY_DIFFERENCE");

    expect(classificationOf(divergence({
      kind: "DATA_DIFFERENCE", legacyBoundary: "live price", v2Boundary: "sealed snapshot price",
    }))).toBe("DATA_DIFFERENCE");

    expect(classificationOf(divergence({ kind: "RISK_DIFFERENCE", riskRule: "correlated index exposure" })))
      .toBe("RISK_DIFFERENCE");

    expect(classificationOf(divergence({ kind: "EXPECTED_ARCHITECTURAL_CHANGE", designDecision: "I18" })))
      .toBe("EXPECTED_ARCHITECTURAL_CHANGE");

    expect(classificationOf(divergence({ kind: "EXECUTION_DIFFERENCE", executionCondition: "stale option chain" })))
      .toBe("EXECUTION_DIFFERENCE");
  });

  it("does not block promotion on the five explanatory classifications", () => {
    // §6: all classifications other than UNKNOWN and unresolved BUG are acceptable, and logged.
    const acceptable: DivergenceEvidence[] = [
      { kind: "EXPECTED_ARCHITECTURAL_CHANGE", designDecision: "I18" },
      { kind: "DATA_DIFFERENCE", legacyBoundary: "live price", v2Boundary: "sealed snapshot" },
      { kind: "POLICY_DIFFERENCE", legacyPolicyVersion: "A", v2PolicyVersion: "B" },
      { kind: "RISK_DIFFERENCE", riskRule: "correlated exposure" },
      { kind: "EXECUTION_DIFFERENCE", executionCondition: "stale chain" },
    ];

    for (const evidence of acceptable) {
      expect(promotionBlocker(divergence(evidence)), evidence.kind).toBeNull();
    }
  });
});

describe("the promotion rule", () => {
  it("blocks on UNKNOWN, and says what the two systems actually said", () => {
    const blocker = promotionBlocker(divergence({ kind: "UNKNOWN" }));

    expect(blocker).toMatch(/UNKNOWN/);
    // A blocker a reader cannot act on is a blocker that gets overridden.
    expect(blocker).toMatch(/V1 said APPROVED, V2 said REJECTED/);
  });

  it("blocks a BUG until it is resolved, not merely identified", () => {
    expect(promotionBlocker(divergence({ kind: "BUG", resolutionRef: null })))
      .toMatch(/no resolution recorded/);
    expect(promotionBlocker(divergence({ kind: "BUG", resolutionRef: "fixed in abc1234" })))
      .toBeNull();
  });

  it("reports every classification at zero rather than omitting it", () => {
    /*
     * A category missing from a report is indistinguishable from a category that never occurred, and
     * the second is the interesting reading. `UNKNOWN: 0` is a claim worth being able to make.
     */
    const verdict = evaluateDifferentialRun({ observations: [observation()], divergences: [] });

    expect(Object.keys(verdict.byClassification).sort()).toEqual([
      "BUG", "DATA_DIFFERENCE", "EXECUTION_DIFFERENCE", "EXPECTED_ARCHITECTURAL_CHANGE",
      "POLICY_DIFFERENCE", "RISK_DIFFERENCE", "UNKNOWN",
    ]);
    expect(verdict.byClassification.UNKNOWN).toBe(0);
  });

  it("is promotable when every divergence is explained", () => {
    const verdict = evaluateDifferentialRun({
      observations: [observation(), observation({ comparisonKey: "BANKNIFTY@09:25", v2Outcome: "REJECTED" })],
      divergences: [divergence(
        { kind: "RISK_DIFFERENCE", riskRule: "correlated index exposure" },
        { comparisonKey: "BANKNIFTY@09:25" },
      )],
    });

    expect(verdict.comparisons).toBe(2);
    expect(verdict.agreements).toBe(1);
    expect(verdict.divergences).toBe(1);
    expect(verdict.byClassification.RISK_DIFFERENCE).toBe(1);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.promotable).toBe(true);
  });

  it("refuses to call an empty run promotable", () => {
    /*
     * Not an oversight. Zero comparisons is no evidence, and the one thing this gate must never do is
     * read "nothing went wrong" off a run that asked nothing -- which is exactly what a
     * cutover-by-absence-of-complaints would be.
     */
    const verdict = evaluateDifferentialRun({ observations: [], divergences: [] });

    expect(verdict.comparisons).toBe(0);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.promotable).toBe(false);
  });

  it("blocks the whole run on a single UNKNOWN among many explained divergences", () => {
    // One unexplained divergence is enough. The gate is not a majority vote.
    const verdict = evaluateDifferentialRun({
      observations: [observation(), observation({ comparisonKey: "B@1" }), observation({ comparisonKey: "C@2" })],
      divergences: [
        divergence({ kind: "POLICY_DIFFERENCE", legacyPolicyVersion: "A", v2PolicyVersion: "B" }, { comparisonKey: "B@1" }),
        divergence({ kind: "UNKNOWN" }, { comparisonKey: "C@2" }),
      ],
    });

    expect(verdict.divergences).toBe(2);
    expect(verdict.blockers).toHaveLength(1);
    expect(verdict.promotable).toBe(false);
  });

  it("refuses a run containing a non-comparison, rather than scoring around it", () => {
    // An uninterpretable row must not sit beside interpretable ones, because the gate counts rows.
    expect(() => evaluateDifferentialRun({
      observations: [observation({ v2SnapshotRef: "snap-other" })],
      divergences: [],
    })).toThrow(/read different snapshots/);
  });
});

describe("agreement that nobody traded is not evidence", () => {
  function declined(comparisonKey: string) {
    return observation({ comparisonKey, legacyOutcome: "NO_TRADE", v2Outcome: "NO_TRADE" });
  }

  it("blocks a run in which neither system ever traded", () => {
    /*
     * Measured on the first corrected pass: 2 comparisons, 2 agreements, 0 divergences,
     * promotable: true -- off a bar outside the executable window where neither system acted. A count
     * above zero was the whole coverage test, so "nothing went wrong" was read off a run that asked
     * nothing twice.
     */
    const verdict = evaluateDifferentialRun({
      observations: [declined("NIFTY50@15:30"), declined("BANKNIFTY@15:30")],
      divergences: [],
    });

    expect(verdict.comparisons).toBe(2);
    expect(verdict.agreements).toBe(2);
    expect(verdict.decisiveComparisons).toBe(0);
    expect(verdict.promotable).toBe(false);
    expect(verdict.blockers).toHaveLength(1);
    expect(verdict.blockers[0]).toContain("NO_DECISIVE_COMPARISON");
  });

  it("does not improve as the agreeing population grows", () => {
    // The failure mode if this were left alone: V2.2 can only refuse today, so every observation it
    // produces agrees with a V1 that also declined, and 100% agreement accrues over a population
    // containing no trading decisions at all.
    const many = Array.from({ length: 500 }, (_, i) => declined(`NIFTY50@bar-${i}`));
    const verdict = evaluateDifferentialRun({ observations: many, divergences: [] });

    expect(verdict.agreements).toBe(500);
    expect(verdict.promotable).toBe(false);
  });

  it("counts a comparison as decisive when either side traded", () => {
    // One-sided is the case P13 exists for, so it must be decisive -- it is also a divergence.
    const legacyTraded = observation({ legacyOutcome: "APPROVED SHORT entry=23860.00", v2Outcome: "NO_TRADE" });
    const v2Traded = observation({ legacyOutcome: "NO_TRADE", v2Outcome: "APPROVED SHORT entry=23860.00" });

    expect(isDecisive(legacyTraded)).toBe(true);
    expect(isDecisive(v2Traded)).toBe(true);
    expect(isDecisive(observation({ legacyOutcome: "NO_TRADE", v2Outcome: "NO_TRADE" }))).toBe(false);
  });

  it("still refuses an empty run, and says so separately", () => {
    // Zero comparisons is not "no decisive comparisons": there is no population at all. Reporting one
    // blocker for the other would misdescribe what is missing.
    const verdict = evaluateDifferentialRun({ observations: [], divergences: [] });

    expect(verdict.promotable).toBe(false);
    expect(verdict.blockers).toHaveLength(0);
    expect(verdict.decisiveComparisons).toBe(0);
  });

  it("lets a decisive run through when its divergences are explained", () => {
    // The gate must not become unpassable: one real trading comparison is enough to clear this
    // particular blocker, which is a coverage floor and not a sample-size test.
    const verdict = evaluateDifferentialRun({
      observations: [observation(), declined("BANKNIFTY@15:30")],
      divergences: [],
    });

    expect(verdict.decisiveComparisons).toBe(1);
    expect(verdict.promotable).toBe(true);
  });
});
