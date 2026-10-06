import { describe, expect, it } from "vitest";
import {
  directionalInformationCurve,
  pathStudyVerdict,
  type PathContrastUnit,
} from "./directional-information-curve.js";
import type { BarrierFreeHorizonObservation, BarrierFreePathResult } from "./barrier-free-path.js";
import { barrierFreePathPolicyVersion } from "./barrier-free-path.js";

const HORIZONS = [1, 5, 15];

function path(
  returnsByHorizon: Record<number, number | null>,
): BarrierFreePathResult {
  const observations: BarrierFreeHorizonObservation[] = HORIZONS.map((horizonMinutes) => {
    const value = returnsByHorizon[horizonMinutes];
    const complete = value !== null && value !== undefined;
    return {
      horizonMinutes,
      status: complete ? "COMPLETE" : "INELIGIBLE_SESSION_BOUNDARY",
      statusReason: complete ? null : "SESSION_BOUNDARY",
      barsExpected: horizonMinutes,
      barsObserved: complete ? horizonMinutes : 0,
      closePrice: complete ? 100 : null,
      directionalReturnPoints: complete ? value : null,
      directionalReturnBps: complete ? value : null,
      directionalReturnAtr: complete ? value : null,
      mfePoints: complete ? Math.max(value, 0) : null,
      mfeBps: complete ? Math.max(value, 0) : null,
      mfeAtr: complete ? Math.max(value, 0) : null,
      maePoints: complete ? 0 : null,
      maeBps: complete ? 0 : null,
      maeAtr: complete ? 0 : null,
      timeToMfeMinutes: complete ? 1 : null,
      timeToMaeMinutes: null,
      giveBackRatio: null,
      retentionRatio: null,
    };
  });
  return { policyVersion: barrierFreePathPolicyVersion, observations };
}

function unit(
  subjectId: string,
  sessionId: string,
  selected: Record<number, number | null>,
  controls: Record<number, number | null>[],
): PathContrastUnit {
  return {
    subjectId,
    sessionId,
    strategyDefinitionHashes: ["a".repeat(64)],
    selected: path(selected),
    controls: controls.map(path),
  };
}

describe("directional information curve", () => {
  it("reports selected, controls and their difference at each horizon", () => {
    const units = [
      unit("s1", "2026-08-24", { 1: 3, 5: 6, 15: 1 }, [{ 1: 1, 5: 2, 15: 1 }, { 1: 1, 5: 0, 15: 1 }]),
      unit("s2", "2026-08-25", { 1: 5, 5: 8, 15: 0 }, [{ 1: 1, 5: 2, 15: 0 }, { 1: 3, 5: 2, 15: 2 }]),
    ];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 400 });

    const at5 = curve.rows.find((row) => row.horizonMinutes === 5)!;
    // Day 1: selected 6, controls mean 1 -> +5. Day 2: selected 8, controls mean 2 -> +6.
    expect(at5.selected.meanPerDay).toBe(7);
    expect(at5.controls.meanPerDay).toBe(1.5);
    expect(at5.incremental.meanPerDay).toBe(5.5);
  });

  it("locates the peak, the half decay and the zero cross separately", () => {
    // A curve that rises, halves, then crosses zero -- the shape the 1m thesis predicts.
    const units = [
      unit("s1", "2026-08-24", { 1: 2, 5: 8, 15: -1 }, [{ 1: 1, 5: 1, 15: 1 }]),
      unit("s2", "2026-08-25", { 1: 2, 5: 8, 15: -1 }, [{ 1: 1, 5: 1, 15: 1 }]),
    ];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 400 });

    expect(curve.peakHorizonMinutes).toBe(5);
    expect(curve.halfDecayHorizonMinutes).toBe(15);
    expect(curve.zeroCrossHorizonMinutes).toBe(15);
  });

  it("reports no decay landmarks when the peak itself is not positive", () => {
    // Halving a negative maximum is not decay, and claiming a half-life for it would assert a shape the
    // data has not shown.
    const units = [
      unit("s1", "2026-08-24", { 1: -3, 5: -5, 15: -9 }, [{ 1: 1, 5: 1, 15: 1 }]),
      unit("s2", "2026-08-25", { 1: -3, 5: -5, 15: -9 }, [{ 1: 1, 5: 1, 15: 1 }]),
    ];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 400 });

    expect(curve.peakHorizonMinutes).toBe(1);
    expect(curve.halfDecayHorizonMinutes).toBeNull();
    expect(curve.zeroCrossHorizonMinutes).toBeNull();
  });

  it("drops a subject whose controls did not all resolve, and says which reason", () => {
    // Averaging over whichever controls survived would measure the subject against a smaller, different
    // baseline than its peers -- and that difference in baselines would enter the estimate as signal.
    const units = [
      unit("s1", "2026-08-24", { 1: 4, 5: 4, 15: 4 }, [{ 1: 1, 5: 1, 15: null }]),
      unit("s2", "2026-08-25", { 1: 4, 5: 4, 15: null }, [{ 1: 1, 5: 1, 15: 1 }]),
    ];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 400 });

    const at15 = curve.rows.find((row) => row.horizonMinutes === 15)!;
    expect(at15.eligibility.eligibleSubjects).toBe(0);
    expect(at15.eligibility.subjectsExcludedByHorizon).toBe(1);
    expect(at15.eligibility.subjectsExcludedByControls).toBe(1);
  });

  it("counts eligible sessions rather than eligible subjects", () => {
    // Twenty subjects from one day are one independent observation. Reporting the subject count alone is
    // how a busy session reads as a large sample.
    const units = [
      unit("s1", "2026-08-24", { 1: 4, 5: 4, 15: 4 }, [{ 1: 1, 5: 1, 15: 1 }]),
      unit("s2", "2026-08-24", { 1: 4, 5: 4, 15: 4 }, [{ 1: 1, 5: 1, 15: 1 }]),
      unit("s3", "2026-08-24", { 1: 4, 5: 4, 15: 4 }, [{ 1: 1, 5: 1, 15: 1 }]),
    ];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 400 });

    const at1 = curve.rows.find((row) => row.horizonMinutes === 1)!;
    expect(at1.eligibility.eligibleSubjects).toBe(3);
    expect(at1.eligibility.eligibleSessions).toBe(1);
    // One day cannot express between-day variance, so there is no interval to report.
    expect(at1.incremental.ci95).toBeNull();
  });

  it("refuses to pool two strategy-definition cohorts", () => {
    const mixed = [
      unit("s1", "2026-08-24", { 1: 1, 5: 1, 15: 1 }, [{ 1: 1, 5: 1, 15: 1 }]),
      { ...unit("s2", "2026-08-25", { 1: 1, 5: 1, 15: 1 }, [{ 1: 1, 5: 1, 15: 1 }]),
        strategyDefinitionHashes: ["b".repeat(64)] },
    ];
    expect(() => directionalInformationCurve(mixed, HORIZONS, "DIRECTIONAL_RETURN_BPS"))
      .toThrow(/cohorts/);
  });

  it("excludes a subject with no controls at all", () => {
    const units = [unit("s1", "2026-08-24", { 1: 4, 5: 4, 15: 4 }, [])];
    const curve = directionalInformationCurve(units, HORIZONS, "DIRECTIONAL_RETURN_BPS");
    expect(curve.rows[0]!.eligibility.eligibleSubjects).toBe(0);
    expect(curve.rows[0]!.eligibility.subjectsExcludedByControls).toBe(1);
  });

  it("reads any registered metric, not only the directional return", () => {
    const units = [
      unit("s1", "2026-08-24", { 1: 3, 5: 3, 15: 3 }, [{ 1: 1, 5: 1, 15: 1 }]),
      unit("s2", "2026-08-25", { 1: 3, 5: 3, 15: 3 }, [{ 1: 1, 5: 1, 15: 1 }]),
    ];
    // The synthetic fixture sets MFE to max(return, 0), so the MFE curve is computable and distinct.
    const mfe = directionalInformationCurve(units, HORIZONS, "MFE_BPS", { replicates: 400 });
    expect(mfe.metric).toBe("MFE_BPS");
    expect(mfe.rows[0]!.incremental.meanPerDay).toBe(2);

    // Give-back is null throughout the fixture, so its curve must be empty rather than zero-valued.
    const giveBack = directionalInformationCurve(units, HORIZONS, "GIVE_BACK_RATIO");
    expect(giveBack.rows[0]!.eligibility.eligibleSubjects).toBe(0);
    expect(giveBack.peakHorizonMinutes).toBeNull();
  });
});

describe("path study verdict", () => {
  const MINIMUM = 20;
  const days = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24"];

  /** A consistently positive contrast across `count` sessions. */
  const positiveCurve = (count: number) => directionalInformationCurve(
    days.slice(0, count).map((sessionId, index) =>
      unit(`s${index}`, sessionId, { 1: 40 + index, 5: 41 - index, 15: 40 }, [{ 1: 1, 5: 1, 15: 1 }])),
    HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 800 },
  );

  /*
   * The defect this pins.
   *
   * With d day means a replicate draws d of them with replacement, so P(all draws hit the minimum) is
   * d^-d -- 25% at two days, 3.7% at three. Both exceed the 2.5% percentile being read, so the reported
   * lower bound *is* the minimum day mean and "lower > 0" collapses into "every day was positive". A
   * null simulation fires 24% of the time at two days. The first version of this verdict reported
   * PATH_INFORMATION from exactly that, on 14 of 36 real cells.
   */
  it("refuses an information claim while the interval is degenerate", () => {
    for (const count of [2, 3, 4]) {
      const verdict = pathStudyVerdict(positiveCurve(count), count, MINIMUM);
      expect(verdict).toContain("DEGENERATE_INTERVAL");
      expect(verdict).not.toContain("PATH_INFORMATION_AT_HORIZONS");
      // The suppressed count is still reported, so refusing is not the same as hiding.
      expect(verdict).toMatch(/\d+ of \d+ horizons would otherwise have registered/);
    }
  });

  it("confirms the degenerate lower bound really is the minimum day mean", () => {
    // The mechanism, not just the guard: two days give an interval whose ends are the two day means.
    const curve = positiveCurve(2);
    const at15 = curve.rows.find((row) => row.horizonMinutes === 15)!;
    expect(at15.incremental.ci95).toEqual({ lower: 39, upper: 39 });
  });

  it("names the horizons whose interval clears zero once the interval is usable", () => {
    const verdict = pathStudyVerdict(positiveCurve(6), 6, MINIMUM);
    expect(verdict).toContain("PATH_INFORMATION_AT_HORIZONS");
    expect(verdict).toContain("confirm on data this estimate never saw");
  });

  it("marks a usable verdict provisional below the decision-grade minimum", () => {
    expect(pathStudyVerdict(positiveCurve(6), 6, MINIMUM)).toContain("PROVISIONAL");
    // Same curve, asserted at a session count that clears the minimum: the standing changes, not the
    // finding. A gate reading is not a decision.
    expect(pathStudyVerdict(positiveCurve(6), 25, MINIMUM)).not.toContain("PROVISIONAL");
  });

  it("returns no-information when every interval includes zero", () => {
    const noisy = directionalInformationCurve(
      days.map((sessionId, index) =>
        unit(`s${index}`, sessionId, {
          1: index % 2 === 0 ? 10 : -12, 5: index % 2 === 0 ? -10 : 11, 15: index % 2 === 0 ? 5 : -6,
        }, [{ 1: 1, 5: 1, 15: 1 }])),
      HORIZONS, "DIRECTIONAL_RETURN_BPS", { replicates: 800 },
    );
    expect(pathStudyVerdict(noisy, days.length, MINIMUM)).toContain("NO_PATH_INFORMATION");
  });

  it("reports insufficient days rather than a verdict on one session", () => {
    const single = directionalInformationCurve(
      [unit("s1", "2026-08-24", { 1: 50, 5: 50, 15: 50 }, [{ 1: 1, 5: 1, 15: 1 }])],
      HORIZONS, "DIRECTIONAL_RETURN_BPS",
    );
    expect(pathStudyVerdict(single, 1, MINIMUM)).toContain("INSUFFICIENT_DAYS");
  });
});
