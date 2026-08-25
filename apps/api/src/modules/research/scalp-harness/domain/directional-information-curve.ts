import type { BarrierFreeHorizonObservation, BarrierFreePathResult } from "./barrier-free-path.js";
import {
  assertSingleCohort,
  summariseByDayBootstrap,
  type CohortTagged,
  type EstimateSummary,
} from "./estimators.js";

/**
 * The Directional Information Curve — stage G1's answer, and the gate everything downstream sits behind.
 *
 * ## What it is, and what it deliberately is not
 *
 * For each horizon: the selected population's forward path, the mean of its matched controls' forward
 * paths, and the difference. The difference is the quantity that matters, and the reason is that neither
 * side answers the question alone:
 *
 *   a positive selected level with no contrast  → the market paid everyone; the signal added nothing
 *   a positive contrast with a negative level   → the signal picks better-than-random moments in a
 *                                                 market that pays nothing
 *
 * Both readings are common and they imply opposite decisions, which is why an earlier round of this
 * project's reasoning — "gross expectancy is about zero, therefore stop" — was the wrong prerequisite.
 * Gross level is not the gate. Control-adjusted information is.
 *
 * No bracket appears anywhere in here. That is the point of running it before any geometry search: a
 * curve computed from bracket-truncated outcomes would already have been shaped by the geometry it is
 * supposed to inform.
 *
 * ## Why the interval belongs to the per-day statistic
 *
 * Outcomes inside one session share a regime, a trend and overlapping forward windows, so trades are
 * not independent draws and per-trade inference manufactures significance. The resampling unit is the
 * trading day, exactly as in the Section-4 estimands, and this reuses that estimator rather than
 * growing a second one that could drift from it.
 */

export type PathMetric =
  | "DIRECTIONAL_RETURN_BPS"
  | "DIRECTIONAL_RETURN_ATR"
  | "MFE_BPS"
  | "MAE_BPS"
  | "GIVE_BACK_RATIO"
  | "RETENTION_RATIO";

/** One treated subject's barrier-free path, paired with the paths of its matched controls. */
export interface PathContrastUnit extends CohortTagged {
  readonly subjectId: string;
  /** IST trading day — the bootstrap cluster. */
  readonly sessionId: string;
  readonly selected: BarrierFreePathResult;
  readonly controls: readonly BarrierFreePathResult[];
}

export interface HorizonEligibility {
  /** Treated subjects whose own observation at this horizon was complete. */
  readonly eligibleSubjects: number;
  /** Distinct trading days those subjects span — the effective sample, not the subject count. */
  readonly eligibleSessions: number;
  /** Subjects dropped because the treated side was ineligible or incomplete. */
  readonly subjectsExcludedByHorizon: number;
  /** Subjects dropped because their control set did not fully resolve at this horizon. */
  readonly subjectsExcludedByControls: number;
}

export interface HorizonRow {
  readonly horizonMinutes: number;
  readonly metric: PathMetric;
  readonly selected: EstimateSummary;
  readonly controls: EstimateSummary;
  /** selected − mean(controls), paired per subject. The quantity the gate reads. */
  readonly incremental: EstimateSummary;
  readonly eligibility: HorizonEligibility;
}

export interface DirectionalInformationCurve {
  readonly metric: PathMetric;
  readonly rows: readonly HorizonRow[];
  /** The horizon with the largest incremental point estimate, or null when none is computable. */
  readonly peakHorizonMinutes: number | null;
  /** First horizon after the peak whose incremental estimate has fallen to half of it or below. */
  readonly halfDecayHorizonMinutes: number | null;
  /** First horizon after the peak whose incremental estimate is at or below zero. */
  readonly zeroCrossHorizonMinutes: number | null;
}

function metricOf(observation: BarrierFreeHorizonObservation, metric: PathMetric): number | null {
  if (observation.status !== "COMPLETE") return null;
  switch (metric) {
    case "DIRECTIONAL_RETURN_BPS": return observation.directionalReturnBps;
    case "DIRECTIONAL_RETURN_ATR": return observation.directionalReturnAtr;
    case "MFE_BPS": return observation.mfeBps;
    case "MAE_BPS": return observation.maeBps;
    case "GIVE_BACK_RATIO": return observation.giveBackRatio;
    case "RETENTION_RATIO": return observation.retentionRatio;
  }
}

function observationAt(
  result: BarrierFreePathResult,
  horizonMinutes: number,
): BarrierFreeHorizonObservation | undefined {
  return result.observations.find((observation) => observation.horizonMinutes === horizonMinutes);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Builds one metric's curve across the horizon ladder.
 *
 * A subject contributes at a horizon only when its own observation is complete *and* every one of its
 * controls resolves there. Requiring the full control set rather than averaging whichever survived
 * keeps the contrast like-for-like: a subject whose controls partly failed would otherwise be measured
 * against a smaller, different baseline than its peers, and the difference between those baselines
 * would enter the estimate as if it were signal.
 *
 * The two exclusion counts are reported separately because they mean different things — a treated
 * subject lost to the session boundary is a horizon-eligibility fact, while a subject lost to its
 * controls is a matching-density fact, and only the first is expected to grow with the horizon.
 */
export function directionalInformationCurve(
  units: readonly PathContrastUnit[],
  horizonsMinutes: readonly number[],
  metric: PathMetric,
  options: { readonly replicates?: number } = {},
): DirectionalInformationCurve {
  assertSingleCohort(units);
  const horizons = [...horizonsMinutes].sort((left, right) => left - right);

  const rows = horizons.map((horizonMinutes): HorizonRow => {
    const selectedContributions: { sessionId: string; value: number }[] = [];
    const controlContributions: { sessionId: string; value: number }[] = [];
    const incrementalContributions: { sessionId: string; value: number }[] = [];
    const sessions = new Set<string>();
    let excludedByHorizon = 0;
    let excludedByControls = 0;

    for (const unit of units) {
      const treated = observationAt(unit.selected, horizonMinutes);
      const treatedValue = treated === undefined ? null : metricOf(treated, metric);
      if (treatedValue === null) {
        excludedByHorizon += 1;
        continue;
      }

      const controlValues: number[] = [];
      for (const control of unit.controls) {
        const observation = observationAt(control, horizonMinutes);
        const value = observation === undefined ? null : metricOf(observation, metric);
        if (value !== null) controlValues.push(value);
      }
      if (unit.controls.length === 0 || controlValues.length !== unit.controls.length) {
        excludedByControls += 1;
        continue;
      }

      sessions.add(unit.sessionId);
      selectedContributions.push({ sessionId: unit.sessionId, value: treatedValue });
      controlContributions.push({ sessionId: unit.sessionId, value: mean(controlValues) });
      incrementalContributions.push({
        sessionId: unit.sessionId,
        value: treatedValue - mean(controlValues),
      });
    }

    const seed = `path-study-v1-${metric}-${horizonMinutes}`;
    return {
      horizonMinutes,
      metric,
      selected: summariseByDayBootstrap(selectedContributions, excludedByHorizon + excludedByControls, {
        seed: `${seed}-selected`, ...options,
      }),
      controls: summariseByDayBootstrap(controlContributions, excludedByHorizon + excludedByControls, {
        seed: `${seed}-controls`, ...options,
      }),
      incremental: summariseByDayBootstrap(
        incrementalContributions,
        excludedByHorizon + excludedByControls,
        { seed: `${seed}-incremental`, ...options },
      ),
      eligibility: {
        eligibleSubjects: incrementalContributions.length,
        eligibleSessions: sessions.size,
        subjectsExcludedByHorizon: excludedByHorizon,
        subjectsExcludedByControls: excludedByControls,
      },
    };
  });

  return { metric, rows, ...decayShape(rows) };
}

/**
 * Where the information peaks and how it fades, as three separate descriptive quantities.
 *
 * Deliberately not a single "half-life". A half-life is only meaningful for a curve that decays
 * monotonically from a maximum, and an information curve can be non-monotonic, can cross zero, and can
 * peak at its first horizon. Reporting three landmarks that may each be null says what the curve
 * actually does; compressing them into one number would assert a shape the data has not shown.
 *
 * All three read the point estimate, not the interval, and are therefore descriptive only — a peak whose
 * interval spans zero is a peak in noise. The gate reads intervals; this reads shape.
 */
function decayShape(rows: readonly HorizonRow[]): {
  peakHorizonMinutes: number | null;
  halfDecayHorizonMinutes: number | null;
  zeroCrossHorizonMinutes: number | null;
} {
  const computable = rows.filter((row) => row.incremental.meanPerDay !== null);
  if (computable.length === 0) {
    return { peakHorizonMinutes: null, halfDecayHorizonMinutes: null, zeroCrossHorizonMinutes: null };
  }
  const peak = computable.reduce((best, row) =>
    row.incremental.meanPerDay! > best.incremental.meanPerDay! ? row : best);
  const peakValue = peak.incremental.meanPerDay!;
  const after = computable.filter((row) => row.horizonMinutes > peak.horizonMinutes);

  // Only meaningful for a peak that is actually positive; halving a negative maximum is not decay.
  const halfDecay = peakValue > 0
    ? after.find((row) => row.incremental.meanPerDay! <= peakValue / 2)
    : undefined;
  const zeroCross = peakValue > 0
    ? after.find((row) => row.incremental.meanPerDay! <= 0)
    : undefined;

  return {
    peakHorizonMinutes: peak.horizonMinutes,
    halfDecayHorizonMinutes: halfDecay?.horizonMinutes ?? null,
    zeroCrossHorizonMinutes: zeroCross?.horizonMinutes ?? null,
  };
}

/**
 * Below this many trading days the day-clustered percentile interval is degenerate and no information
 * claim may be read from it.
 *
 * Measured, not assumed. With `d` day means, a bootstrap replicate draws `d` of them with replacement,
 * so the probability that every draw lands on the minimum is `d^-d`. At two days that is 25% and at
 * three it is 3.7% — both above the 2.5% percentile being read — so the reported lower bound *is* the
 * minimum day mean, and `lower > 0` degrades to "every day happened to be positive". A null simulation
 * confirms it fires 24% of the time at two days rather than 2.5%. At four days `d^-d` falls to 0.39%
 * and the percentile finally moves off the minimum, so five is the first count with any margin.
 *
 * This is deliberately the same boundary as `EARLY_DIAGNOSTIC` in the study registry: that band means
 * "the interval cannot be trusted at all", and this is what that costs in practice.
 */
export const degenerateIntervalSessionCeiling = 5;

/**
 * The G1 verdict for one cell, read from the incremental interval rather than the point estimate.
 *
 * Separate from the shape landmarks above because a peak is not evidence. The gate asks one thing: is
 * there a horizon at which the control-adjusted advantage is distinguishable from zero? If not, the
 * geometry search does not start — sweeping 35 cells over a population with no established information
 * produces a winning cell by multiplicity, which is how both prior sweeps here reached their negatives.
 *
 * Takes the session count rather than a precomputed flag, so the verdict derives its own standing and a
 * caller cannot pass one that disagrees with the data.
 */
export function pathStudyVerdict(
  curve: DirectionalInformationCurve,
  sessionCount: number,
  decisionGradeSessionMinimum: number,
): string {
  const computable = curve.rows.filter((row) => row.incremental.ci95 !== null);
  if (computable.length === 0) {
    return "INSUFFICIENT_DAYS — no horizon has two distinct trading days, so no interval exists";
  }
  const positive = computable.filter((row) => row.incremental.ci95!.lower > 0);

  /*
   * Refused rather than qualified.
   *
   * A "PATH_INFORMATION" verdict with a provisional tag attached still reads as a positive finding, and
   * at this session count the underlying test fires roughly a quarter of the time on noise. The count of
   * horizons that *would* have fired is reported so nothing is hidden — but it is reported as a
   * diagnostic, not as a claim.
   */
  if (sessionCount < degenerateIntervalSessionCeiling) {
    return `DEGENERATE_INTERVAL — ${sessionCount} trading day(s). The percentile lower bound is the `
      + "minimum day mean here, so an interval above zero only says every day was positive, which "
      + "happens on roughly a quarter of noise draws at two days. No information claim is possible; "
      + `${positive.length} of ${computable.length} horizons would otherwise have registered.`;
  }

  const standing = sessionCount >= decisionGradeSessionMinimum
    ? ""
    : " (PROVISIONAL — below the decision-grade session minimum)";
  if (positive.length === 0) {
    return "NO_PATH_INFORMATION — every horizon's incremental interval includes zero or sits below it"
      + standing;
  }
  const horizons = positive.map((row) => row.horizonMinutes).join(",");
  return `PATH_INFORMATION_AT_HORIZONS:${horizons} — exploratory; confirm on data this estimate never `
    + `saw before searching geometry${standing}`;
}
