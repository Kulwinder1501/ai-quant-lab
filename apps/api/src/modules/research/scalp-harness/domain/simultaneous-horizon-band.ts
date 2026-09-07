import {
  horizonContributions,
  type PathContrastUnit,
  type PathMetric,
} from "./directional-information-curve.js";
import { seededUniform } from "./estimators.js";

/**
 * SIMULTANEOUS_DAY_MAXT_V1 — one band over the whole horizon ladder, as registered by PATH_STUDY_V2.
 *
 * ## The problem it exists to fix
 *
 * Ten pointwise 95% intervals do not give 95% coverage across ten inspected horizons. Reading the
 * curve, choosing the horizon that looks best and quoting its interval is a search, and PATH_STUDY_V1's
 * verdict did exactly that: on two sessions it reported positive information on 14 of 36 cells at
 * scattered horizons, from a test that fires roughly a quarter of the time on noise at that cluster
 * count. The fix is to test the curve as one object.
 *
 * ## The statistic
 *
 *   H0:  edge_h <= 0 for every retained horizon
 *   H1:  edge_h >  0 for at least one retained horizon
 *
 * Trading days are the resampling unit. For each horizon, `edge_h` is the mean of per-day mean
 * contrasts and `SE_h` its day-level standard error. The bootstrap draws day sets with replacement and
 * takes, per replicate, the maximum studentized deviation across horizons:
 *
 *   U*_h = (mean*_h - mean_h) / SE*_h        T* = max_h U*_h        c = quantile_0.95(T*)
 *
 * The band is then `lower_h = mean_h - c * SE_h`, simultaneously valid across horizons: if every
 * `edge_h <= 0`, the probability that any `lower_h` exceeds zero is at most 5%. Studentizing is what
 * makes the maximum meaningful — an unstudentized maximum would simply select the horizon with the
 * widest scale.
 *
 * One-sided by construction, because the Gate-1 question is one-sided. A two-sided band is not produced:
 * it would be an unregistered quantity sitting next to an authoritative one, and the pointwise intervals
 * already serve visualisation.
 *
 * ## Scope
 *
 * This controls the ten-horizon search **within one cell**. It says nothing about the 36 cells a study
 * examines; that remains the trial ledger's multiplicity problem. Reading it as a familywise guarantee
 * over the study would be a much stronger claim than the maximum supports.
 */

export const simultaneousBandPolicyVersion = "SIMULTANEOUS_DAY_MAXT_V1";

/** Registered: 4,000 replicates at 95%, one-sided. */
export const simultaneousBandReplicates = 4_000;
export const simultaneousBandConfidenceLevel = 0.95;

/**
 * Common-support days below which no band is produced.
 *
 * Deliberately the same governance boundary as the pointwise ceiling. Escaping the discrete-bootstrap
 * pathology that binds at two and three days does not make a four-cluster interval trustworthy, and a
 * band published at that count would carry authority the data cannot support.
 */
export const simultaneousBandMinimumDays = 5;

export type HorizonExclusionReason = "INSUFFICIENT_OWN_SUPPORT" | "ZERO_DAY_LEVEL_VARIANCE";

export interface BandHorizonRow {
  readonly horizonMinutes: number;
  /** Mean of per-day mean contrasts over the common-support days. */
  readonly dayMeanEdge: number;
  readonly standardError: number;
  /** `dayMeanEdge − c × standardError`. Null when no band was produced. */
  readonly simultaneousLower: number | null;
}

export interface SimultaneousHorizonBand {
  readonly policyVersion: string;
  readonly metric: PathMetric;
  readonly status: "COMPUTED" | "REFUSED_INSUFFICIENT_DAYS" | "REFUSED_NO_RETAINED_HORIZONS";
  readonly statusReason: string | null;
  readonly commonSupportDays: number;
  readonly commonSupportSessions: readonly string[];
  /** Days dropped for lacking a contribution at every retained horizon. */
  readonly daysExcluded: number;
  readonly retainedHorizons: readonly number[];
  readonly excludedHorizons: readonly { horizonMinutes: number; reason: HorizonExclusionReason }[];
  readonly criticalValue: number | null;
  readonly replicates: number;
  /**
   * Replicates whose resampled day set collapsed onto a single day, giving a zero bootstrap scale.
   *
   * Reported rather than hidden: it is the one place the procedure substitutes a value, and a large
   * count would mean the band rests on very few distinct days.
   */
  readonly replicatesWithSubstitutedScale: number;
  readonly rows: readonly BandHorizonRow[];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard error of a set of day means. `n - 1` denominator; zero for a single day. */
function standardError(dayMeans: readonly number[]): number {
  if (dayMeans.length < 2) return 0;
  const centre = mean(dayMeans);
  const variance = dayMeans.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (dayMeans.length - 1);
  return Math.sqrt(variance / dayMeans.length);
}

function round(value: number): number {
  return Number(value.toFixed(9));
}

/**
 * Builds the band for one cell.
 *
 * ## The two exclusion rules, resolved before any resampling
 *
 * Both are registered, and both are resolved up front because doing either mid-run changes the answer.
 * Dropping a horizon from a maximum *lowers* the critical value and weakens the test — the opposite of
 * what an exclusion should do — so a horizon is never removed once resampling has begun.
 *
 *   1. A horizon whose own day support is below two is excluded as `INSUFFICIENT_OWN_SUPPORT`. Applied
 *      before the intersection, because a horizon that is rarely eligible would otherwise drag the
 *      common-support set down for every other horizon. This is what stops one systematically
 *      boundary-limited horizon from collapsing an entire cell.
 *   2. A horizon with zero day-level variance over the common days is excluded as
 *      `ZERO_DAY_LEVEL_VARIANCE`, since it cannot be studentized. Removing it can only enlarge the
 *      common-support set, so the intersection is recomputed and the check repeated until stable. The
 *      loop terminates because the retained set strictly shrinks.
 *
 * Days are then intersected once: the band resamples only days with a contribution at every retained
 * horizon, so a single resampled day set serves all of them. That is what preserves the dependence
 * between horizons that the maximum is taken over — per-horizon day sets would make the maximum a
 * statistic over incomparable quantities.
 */
export function simultaneousHorizonBand(input: {
  readonly units: readonly PathContrastUnit[];
  readonly horizonsMinutes: readonly number[];
  readonly metric: PathMetric;
  /** Deterministic seed material. Registered as namespace + studyKey + cellKey + metric. */
  readonly seed: string;
  readonly replicates?: number;
}): SimultaneousHorizonBand {
  const metric = input.metric;
  const replicates = input.replicates ?? simultaneousBandReplicates;
  const perHorizon = horizonContributions(input.units, input.horizonsMinutes, metric);

  // Per-horizon day means, before any exclusion.
  const dayMeansByHorizon = new Map<number, Map<string, number>>();
  for (const horizon of perHorizon) {
    const byDay = new Map<string, number[]>();
    for (const contribution of horizon.contributions) {
      const bucket = byDay.get(contribution.sessionId);
      if (bucket) bucket.push(contribution.incremental);
      else byDay.set(contribution.sessionId, [contribution.incremental]);
    }
    dayMeansByHorizon.set(
      horizon.horizonMinutes,
      new Map([...byDay.entries()].map(([day, values]) => [day, mean(values)])),
    );
  }

  const excludedHorizons: { horizonMinutes: number; reason: HorizonExclusionReason }[] = [];
  let retained = perHorizon
    .map((horizon) => horizon.horizonMinutes)
    .filter((horizonMinutes) => {
      const enough = (dayMeansByHorizon.get(horizonMinutes)?.size ?? 0) >= 2;
      if (!enough) excludedHorizons.push({ horizonMinutes, reason: "INSUFFICIENT_OWN_SUPPORT" });
      return enough;
    });

  const allDays = [...new Set(perHorizon.flatMap((horizon) =>
    [...(dayMeansByHorizon.get(horizon.horizonMinutes)?.keys() ?? [])]))];

  const intersect = (horizons: readonly number[]): string[] => horizons.length === 0
    ? []
    : [...new Set(allDays)]
        .filter((day) => horizons.every((horizonMinutes) => dayMeansByHorizon.get(horizonMinutes)?.has(day)))
        .sort();

  let commonDays = intersect(retained);
  // Zero-variance horizons are removed and the intersection recomputed, since removing one can only add
  // days. Strictly shrinking, so this terminates.
  for (;;) {
    const degenerate = retained.filter((horizonMinutes) => {
      const byDay = dayMeansByHorizon.get(horizonMinutes)!;
      return standardError(commonDays.map((day) => byDay.get(day)!)) === 0;
    });
    if (degenerate.length === 0 || commonDays.length < 2) break;
    for (const horizonMinutes of degenerate) {
      excludedHorizons.push({ horizonMinutes, reason: "ZERO_DAY_LEVEL_VARIANCE" });
    }
    retained = retained.filter((horizonMinutes) => !degenerate.includes(horizonMinutes));
    commonDays = intersect(retained);
  }

  const daysExcluded = allDays.length - commonDays.length;
  const rows: BandHorizonRow[] = retained.map((horizonMinutes) => {
    const byDay = dayMeansByHorizon.get(horizonMinutes)!;
    const dayMeans = commonDays.map((day) => byDay.get(day)!);
    return {
      horizonMinutes,
      dayMeanEdge: dayMeans.length === 0 ? 0 : round(mean(dayMeans)),
      standardError: round(standardError(dayMeans)),
      simultaneousLower: null,
    };
  });

  const refuse = (
    status: SimultaneousHorizonBand["status"],
    statusReason: string,
  ): SimultaneousHorizonBand => ({
    policyVersion: simultaneousBandPolicyVersion,
    metric,
    status,
    statusReason,
    commonSupportDays: commonDays.length,
    commonSupportSessions: commonDays,
    daysExcluded,
    retainedHorizons: retained,
    excludedHorizons,
    criticalValue: null,
    replicates,
    replicatesWithSubstitutedScale: 0,
    rows,
  });

  if (retained.length === 0) {
    return refuse(
      "REFUSED_NO_RETAINED_HORIZONS",
      "No horizon has two days of its own support, so there is no curve to band.",
    );
  }
  if (commonDays.length < simultaneousBandMinimumDays) {
    return refuse(
      "REFUSED_INSUFFICIENT_DAYS",
      `${commonDays.length} common-support day(s); ${simultaneousBandMinimumDays} are required. Below `
      + "this a day-clustered percentile procedure is not trustworthy regardless of the statistic, and a "
      + "band published here would carry authority the data cannot support.",
    );
  }

  const observed = retained.map((horizonMinutes) => {
    const byDay = dayMeansByHorizon.get(horizonMinutes)!;
    const dayMeans = commonDays.map((day) => byDay.get(day)!);
    return { horizonMinutes, dayMeans, edge: mean(dayMeans), se: standardError(dayMeans) };
  });

  const next = seededUniform(`${simultaneousBandPolicyVersion}|${input.seed}`);
  const maxima: number[] = [];
  let substituted = 0;
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    // One day set for every horizon, drawn once per replicate. This is the whole point: the maximum is
    // taken across horizons that saw the same resampled days, so their dependence survives.
    const draw: number[] = [];
    for (let index = 0; index < commonDays.length; index += 1) {
      draw.push(Math.floor(next() * commonDays.length));
    }
    let usedSubstitute = false;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const horizon of observed) {
      const resampled = draw.map((index) => horizon.dayMeans[index]!);
      const resampledSe = standardError(resampled);
      /*
       * A replicate that drew the same day every time has zero bootstrap scale. The registered rule
       * forbids discarding the replicate, so the observed sample's standard error is substituted for
       * that horizon. Dropping the replicate instead would remove the most extreme draws from the
       * critical value and make the test less conservative, which is the wrong direction; substituting
       * keeps it finite and keeps the draw.
       */
      const scale = resampledSe === 0 ? horizon.se : resampledSe;
      if (resampledSe === 0) usedSubstitute = true;
      maximum = Math.max(maximum, (mean(resampled) - horizon.edge) / scale);
    }
    if (usedSubstitute) substituted += 1;
    maxima.push(maximum);
  }

  maxima.sort((left, right) => left - right);
  const criticalIndex = Math.min(
    maxima.length - 1,
    Math.max(0, Math.floor(simultaneousBandConfidenceLevel * maxima.length)),
  );
  const criticalValue = maxima[criticalIndex]!;

  return {
    policyVersion: simultaneousBandPolicyVersion,
    metric,
    status: "COMPUTED",
    statusReason: null,
    commonSupportDays: commonDays.length,
    commonSupportSessions: commonDays,
    daysExcluded,
    retainedHorizons: retained,
    excludedHorizons,
    criticalValue: round(criticalValue),
    replicates,
    replicatesWithSubstitutedScale: substituted,
    rows: observed.map((horizon) => ({
      horizonMinutes: horizon.horizonMinutes,
      dayMeanEdge: round(horizon.edge),
      standardError: round(horizon.se),
      simultaneousLower: round(horizon.edge - criticalValue * horizon.se),
    })),
  };
}

/**
 * The Gate-1 verdict under PATH_STUDY_V2 — read from the band, never from a pointwise interval.
 *
 * A claim requires at least one horizon whose simultaneous lower bound clears zero. Under the null that
 * every horizon's edge is non-positive, the chance any bound does so is at most 5% across the whole
 * ladder, which is the guarantee ten separate intervals could not give.
 *
 * The session count still qualifies the standing separately: familywise control across horizons says
 * nothing about whether twenty sessions of evidence exist.
 */
export function simultaneousBandVerdict(
  band: SimultaneousHorizonBand,
  sessionCount: number,
  decisionGradeSessionMinimum: number,
): string {
  if (band.status !== "COMPUTED") {
    return `NO_BAND — ${band.statusReason ?? band.status}`;
  }
  const positive = band.rows.filter((row) => (row.simultaneousLower ?? 0) > 0);
  const standing = sessionCount >= decisionGradeSessionMinimum
    ? ""
    : " (PROVISIONAL — below the decision-grade session minimum)";
  const excluded = band.excludedHorizons.length === 0
    ? ""
    : ` Excluded horizons: ${band.excludedHorizons.map((item) => item.horizonMinutes).join(",")}.`;

  if (positive.length === 0) {
    return "NO_PATH_INFORMATION — no horizon's simultaneous lower bound clears zero across the "
      + `${band.retainedHorizons.length}-horizon ladder.${excluded}${standing}`;
  }
  return `PATH_INFORMATION_AT_HORIZONS:${positive.map((row) => row.horizonMinutes).join(",")} — `
    + "simultaneous across the retained ladder; exploratory, and confirm on data this estimate never "
    + `saw before searching geometry.${excluded}${standing}`;
}
