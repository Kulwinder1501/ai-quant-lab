import { describe, expect, it } from "vitest";
import {
  simultaneousBandMinimumDays,
  simultaneousBandPolicyVersion,
  simultaneousBandVerdict,
  simultaneousHorizonBand,
  type SimultaneousHorizonBand,
} from "./simultaneous-horizon-band.js";
import { barrierFreePathPolicyVersion, type BarrierFreeHorizonObservation, type BarrierFreePathResult } from "./barrier-free-path.js";
import type { PathContrastUnit } from "./directional-information-curve.js";

const HORIZONS = [1, 5, 15];
const MINIMUM = 20;
const DAYS = [
  "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
  "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
];

function path(valueByHorizon: Record<number, number | null>): BarrierFreePathResult {
  const observations: BarrierFreeHorizonObservation[] = HORIZONS.map((horizonMinutes) => {
    const value = valueByHorizon[horizonMinutes];
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
      mfePoints: null, mfeBps: null, mfeAtr: null,
      maePoints: null, maeBps: null, maeAtr: null,
      timeToMfeMinutes: null, timeToMaeMinutes: null,
      giveBackRatio: null, retentionRatio: null,
    };
  });
  return { policyVersion: barrierFreePathPolicyVersion, observations };
}

/** One subject per day, so a day mean is that subject's contrast. */
function unitsFromDailyEdges(
  edgesByDay: readonly Record<number, number | null>[],
  days: readonly string[] = DAYS,
): PathContrastUnit[] {
  return edgesByDay.map((edges, index) => ({
    subjectId: `s${index}`,
    sessionId: days[index]!,
    strategyDefinitionHashes: ["a".repeat(64)],
    // Controls sit at zero, so the contrast equals the selected value and the fixtures stay readable.
    selected: path(edges),
    controls: [path(Object.fromEntries(
      Object.entries(edges).map(([horizon, value]) => [horizon, value === null ? null : 0]),
    ) as Record<number, number | null>)],
  }));
}

const band = (units: PathContrastUnit[], seed = "test") =>
  simultaneousHorizonBand({ units, horizonsMinutes: HORIZONS, metric: "DIRECTIONAL_RETURN_BPS", seed, replicates: 2_000 });

describe("simultaneous horizon band", () => {
  it("carries its registered policy version", () => {
    expect(simultaneousBandPolicyVersion).toBe("SIMULTANEOUS_DAY_MAXT_V1");
  });

  it("produces a lower bound below the point estimate at every horizon", () => {
    const result = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 10 + index, 5: 8 - index * 0.5, 15: 1 + index * 0.2 })),
    ));
    expect(result.status).toBe("COMPUTED");
    expect(result.criticalValue).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.simultaneousLower).toBeLessThan(row.dayMeanEdge);
      expect(row.simultaneousLower).toBeCloseTo(row.dayMeanEdge - result.criticalValue! * row.standardError, 6);
    }
  });

  /*
   * The property the whole build exists for.
   *
   * A simultaneous band must be wider than a pointwise interval at the same level, because it pays for
   * having inspected ten horizons rather than one. If it were not, it would be a pointwise interval with
   * a different name -- and PATH_STUDY_V1's verdict, which read pointwise intervals off a ten-horizon
   * search, would not have been wrong.
   */
  it("is strictly more conservative than a pointwise interval at the same level", () => {
    const result = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 6 + (index % 3), 5: 5 - (index % 2), 15: 4 + (index % 4) * 0.5 })),
    ));
    expect(result.status).toBe("COMPUTED");
    // A one-sided pointwise 95% bound on a normal-ish day mean sits near 1.65 standard errors below it;
    // the simultaneous critical value must exceed that to cover three horizons at once.
    expect(result.criticalValue).toBeGreaterThan(1.65);
  });

  it("refuses below the minimum common-support day count", () => {
    const result = band(unitsFromDailyEdges(
      [{ 1: 5, 5: 5, 15: 5 }, { 1: 6, 5: 6, 15: 6 }, { 1: 7, 5: 7, 15: 7 }, { 1: 8, 5: 8, 15: 8 }],
      DAYS.slice(0, 4),
    ));
    expect(result.status).toBe("REFUSED_INSUFFICIENT_DAYS");
    expect(result.commonSupportDays).toBe(4);
    expect(result.criticalValue).toBeNull();
    // The means are still reported; only the inferential band is withheld.
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.simultaneousLower === null)).toBe(true);
    expect(simultaneousBandMinimumDays).toBe(5);
  });

  /*
   * The rule that stops one boundary-limited horizon from collapsing a cell.
   *
   * +15m is eligible on only one day here. Intersecting first would leave a single common-support day
   * and refuse the whole cell, discarding two perfectly usable horizons -- so the thin horizon is
   * excluded on its own support, before the intersection.
   */
  it("excludes a horizon on its own support before intersecting days", () => {
    const result = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 5 + index, 5: 4 + index * 0.5, 15: index === 0 ? 3 : null })),
    ));
    expect(result.excludedHorizons).toEqual([
      { horizonMinutes: 15, reason: "INSUFFICIENT_OWN_SUPPORT" },
    ]);
    expect(result.retainedHorizons).toEqual([1, 5]);
    expect(result.commonSupportDays).toBe(DAYS.length);
    expect(result.status).toBe("COMPUTED");
  });

  it("excludes a horizon that cannot be studentized, then recovers the days it was costing", () => {
    // +5m is constant across days, so its day-level variance is zero and no studentized deviation
    // exists. Removing it can only enlarge the common-support set, so the intersection is recomputed.
    const result = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 5 + index, 5: 7, 15: 2 + index * 0.3 })),
    ));
    expect(result.excludedHorizons).toEqual([
      { horizonMinutes: 5, reason: "ZERO_DAY_LEVEL_VARIANCE" },
    ]);
    expect(result.retainedHorizons).toEqual([1, 15]);
    expect(result.status).toBe("COMPUTED");
  });

  it("resamples only days present at every retained horizon, and counts the rest", () => {
    // +15m is missing on the last three days. Those days cannot serve a maximum taken across horizons,
    // so they leave the resampled set -- and the count is reported rather than silently absorbed.
    const result = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 5 + index, 5: 4 + index, 15: index < 7 ? 3 + index : null })),
    ));
    expect(result.retainedHorizons).toEqual([1, 5, 15]);
    expect(result.commonSupportDays).toBe(7);
    expect(result.daysExcluded).toBe(3);
    expect(result.commonSupportSessions).toEqual(DAYS.slice(0, 7));
  });

  it("refuses when no horizon has support of its own", () => {
    const result = band(unitsFromDailyEdges([{ 1: 5, 5: null, 15: null }], DAYS.slice(0, 1)));
    expect(result.status).toBe("REFUSED_NO_RETAINED_HORIZONS");
    expect(result.retainedHorizons).toEqual([]);
  });

  it("is deterministic for one seed and moves with the seed", () => {
    const edges = DAYS.map((_, index) => ({ 1: 5 + index, 5: 4 - index * 0.2, 15: 1 + index * 0.4 }));
    const first = band(unitsFromDailyEdges(edges), "seed-a");
    const second = band(unitsFromDailyEdges(edges), "seed-a");
    const other = band(unitsFromDailyEdges(edges), "seed-b");
    expect(first.criticalValue).toBe(second.criticalValue);
    expect(other.criticalValue).not.toBe(first.criticalValue);
  });

  it("keeps every replicate when a draw collapses onto one day, and reports it", () => {
    // The registered rule forbids discarding a replicate: dropping the collapsed draws would remove the
    // most extreme values from the critical value and weaken the test. The substitution is counted so a
    // band resting on very few distinct days is visible.
    const result = simultaneousHorizonBand({
      units: unitsFromDailyEdges(
        DAYS.slice(0, 5).map((_, index) => ({ 1: 5 + index, 5: 4 + index, 15: 3 + index })),
        DAYS.slice(0, 5),
      ),
      horizonsMinutes: HORIZONS,
      metric: "DIRECTIONAL_RETURN_BPS",
      seed: "collapse",
      replicates: 2_000,
    });
    expect(result.status).toBe("COMPUTED");
    expect(result.replicates).toBe(2_000);
    // 5^-4 ≈ 0.16% of draws collapse, so a handful is expected and none may be dropped.
    expect(result.replicatesWithSubstitutedScale).toBeGreaterThan(0);
    expect(result.criticalValue).toBeGreaterThan(0);
  });
});

describe("simultaneous band verdict", () => {
  const strong = () => band(unitsFromDailyEdges(
    DAYS.map((_, index) => ({ 1: 40 + (index % 2), 5: 38 + (index % 3) * 0.5, 15: 39 - (index % 2) })),
  ));
  const noisy = () => band(unitsFromDailyEdges(
    DAYS.map((_, index) => ({
      1: index % 2 === 0 ? 20 : -22, 5: index % 3 === 0 ? -18 : 17, 15: index % 2 === 0 ? -9 : 11,
    })),
  ));

  it("claims only horizons whose simultaneous bound clears zero", () => {
    const verdict = simultaneousBandVerdict(strong(), 25, MINIMUM);
    expect(verdict).toContain("PATH_INFORMATION_AT_HORIZONS");
    expect(verdict).toContain("simultaneous across the retained ladder");
  });

  it("returns no information when the band spans zero everywhere", () => {
    expect(simultaneousBandVerdict(noisy(), 25, MINIMUM)).toContain("NO_PATH_INFORMATION");
  });

  it("qualifies standing by session count independently of familywise control", () => {
    // Controlling the horizon search says nothing about how much evidence exists.
    expect(simultaneousBandVerdict(strong(), 10, MINIMUM)).toContain("PROVISIONAL");
    expect(simultaneousBandVerdict(strong(), 25, MINIMUM)).not.toContain("PROVISIONAL");
  });

  it("reports no band rather than a finding when the band was refused", () => {
    const refused: SimultaneousHorizonBand = band(unitsFromDailyEdges(
      [{ 1: 5, 5: 5, 15: 5 }, { 1: 9, 5: 9, 15: 9 }],
      DAYS.slice(0, 2),
    ));
    const verdict = simultaneousBandVerdict(refused, 2, MINIMUM);
    expect(verdict).toContain("NO_BAND");
    expect(verdict).not.toContain("PATH_INFORMATION_AT_HORIZONS");
  });

  it("names the horizons it dropped, so a narrowed ladder is never silent", () => {
    const narrowed = band(unitsFromDailyEdges(
      DAYS.map((_, index) => ({ 1: 40 + (index % 2), 5: 39 - (index % 2), 15: index === 0 ? 3 : null })),
    ));
    expect(simultaneousBandVerdict(narrowed, 25, MINIMUM)).toContain("Excluded horizons: 15");
  });
});
