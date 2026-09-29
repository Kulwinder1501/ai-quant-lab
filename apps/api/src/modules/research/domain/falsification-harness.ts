import {
  informationCoefficient,
  type InformationCoefficient,
} from "./information-coefficient.js";
import {
  blockPermuted,
  circularShifted,
  DEFAULT_MINIMUM_SWAPPABLE_FRACTION,
  matchedTimeDiversity,
  signFlipped,
  wrongDayMatchedTime,
  type MatchedTimeDiversity,
} from "./placebos.js";
import {
  findLookaheadViolations,
  type LookaheadViolation,
} from "./lookahead-guard.js";

/**
 * The R0 gate: everything a candidate signal must survive before its IC is allowed to mean anything.
 *
 * This runs *before* signal construction is trusted, not after, and it is deliberately the first
 * thing built in the microstructure programme. Its value does not depend on that programme
 * succeeding: any future feature in this project can be pushed through it, and the project's history
 * is largely a list of signals that looked real until something like this was applied.
 *
 * ## The band is self-calibrating, and that is the design
 *
 * There is no hard-coded "significant IC" threshold here, because any such number would be a free
 * parameter inviting exactly the tuning this harness exists to prevent. Instead the placebos define
 * the bar: `placeboBand` is the largest absolute IC produced by any label-destroying transform, and
 * the real IC has to beat it.
 *
 * That has a property a fixed threshold cannot: the band automatically widens for data that is easy
 * to spuriously correlate. Order-flow features and short-horizon returns are both strongly
 * autocorrelated, so block permutation on this data will produce a non-trivial IC by construction —
 * and the real signal is then correctly required to clear a higher bar. A fixed 0.02 threshold would
 * pass noise on autocorrelated data and reject genuine signal on clean data.
 *
 * ## Negative lags, and what a hit there actually means
 *
 * Pairing a feature with a *past* return must produce nothing: the future cannot inform the past.
 * When it does, the cause is essentially never a market effect. It is timestamp skew, a stale
 * feature being carried forward, an off-by-one in the join, or a feature whose "as of" is a lie.
 *
 * A negative-lag hit therefore invalidates the positive-lag result too — the same defect corrupts
 * both — which is why it is a hard failure rather than a note. The whole measurement is void, not
 * merely weaker than hoped.
 *
 * ### The lag probes are judged against a different bar than the real IC, and must be
 *
 * The first version of this file compared negative lags to `placeboBand`, and it was wrong in a way
 * worth recording because it is easy to reintroduce. The band is the *maximum* of several placebo
 * ICs, so on a clean informative feature every placebo collapses toward zero and the band becomes
 * very small — while a single lag probe still carries the ordinary sampling noise of roughly
 * `1/sqrt(n)`. Judging one noisy draw against the tight maximum of several near-zero draws failed
 * legitimate signals for "predicting the past" about half the time. Perfect injected foresight,
 * which must obviously pass, failed.
 *
 * So the lag threshold is `max(placeboBand, sigma / sqrt(n - 1))`: the larger of what label
 * destruction actually achieves on this data, and the analytic noise floor of a rank correlation
 * under the null. The first term is what catches autocorrelation-driven spurious correlation, which
 * the analytic floor is blind to. The second is what stops a tiny band from manufacturing failures.
 * Neither alone is sufficient, which is why the threshold is a maximum rather than a choice.
 *
 * ## Ordering of the verdict is load-bearing
 *
 * Failures are checked in order of what invalidates what. A look-ahead violation makes every
 * downstream number meaningless, so it short-circuits. A placebo breach means the harness itself
 * cannot be trusted, so it must be resolved before any signal claim is entertained — reporting
 * "PASS, but note the placebos also fired" would be reporting a result from a broken instrument.
 *
 * ## The wrong-day-matched-time placebo can go silently degenerate, and must not be trusted then
 *
 * `wrongDayMatchedTime` (placebos.ts) leaves a time-of-day bucket untouched when it has fewer than
 * two distinct calendar days to swap between — correct for one bucket, but a documented no-op when
 * it happens to *every* bucket in the window (a capture that, in effect, only spans one real trading
 * day). When that happens the placebo returns the input essentially unchanged, so its "IC" is really
 * the real IC measured a second time — an exact tie that then silently sets (or dominates) the
 * placebo band, making a possibly-genuine signal read as `NO_SIGNAL` for a reason that has nothing to
 * do with the market. This was found live: three fresh capture windows (2026-09-23/24, 09-25, 09-28)
 * each reported `NO_SIGNAL` with the real IC exactly equal to this placebo's IC to full float
 * precision.
 *
 * `matchedTimeDiversity` (placebos.ts) measures what fraction of observations actually sat in a
 * bucket with real day-to-day diversity to shuffle. Below `minimumSwappableFraction` the placebo is
 * excluded from the placebo band (an untrustworthy number must not silently set the bar), and the
 * whole window's verdict becomes `INCONCLUSIVE` rather than `NO_SIGNAL` or `PASS` — the same
 * "unmeasured must stay unmeasured, never default to a pass/fail" principle applied elsewhere in this
 * codebase. `INCONCLUSIVE` is distinct from a genuine `NO_SIGNAL`: the latter says the signal was
 * measured and found wanting; the former says one of the measuring instruments could not be trusted
 * on this window at all.
 */

export interface FalsificationObservation {
  /** When the decision would have been made. Also the time-of-day anchor for the day placebo. */
  readonly at: Date;
  /** The latest instant any input to this feature was knowable. Audited, not assumed. */
  readonly featureAsOf: Date;
  readonly featureValue: number;
  /** Return realised *after* `at` over the horizon under test. */
  readonly forwardReturn: number;
  /** When that forward return became fully known; required to reject overlapping lag probes. */
  readonly labelEndAt?: Date;
}

export interface FalsificationOptions {
  /**
   * Negative offsets, in observations, at which the feature is paired with an earlier return.
   * Defaults span short and long skew, since a one-step skew and a whole-session skew have
   * different causes.
   */
  readonly negativeLags?: readonly number[];
  readonly seed?: number;
  readonly bootstrapSamples?: number;
  /** Below this many usable pairs the run reports INSUFFICIENT_SAMPLE rather than a verdict. */
  readonly minimumSample?: number;
  /** Block length for the permutation placebo, in observations. */
  readonly blockSize?: number;
  /** Rotation for the circular-shift placebo, in observations. */
  readonly circularShift?: number;
  /**
   * How many null standard errors a negative lag must exceed to count as skew. Default 3, which
   * is roughly a two-sided 0.003 per probe and tolerates the handful of probes run here.
   */
  readonly negativeLagSigma?: number;
  /**
   * `hard` is appropriate for features that cannot causally depend on past returns.
   * Use `diagnostic` for explicitly price-derived features such as momentum, where correlation
   * with realised history is expected and is not evidence of timestamp leakage.
   */
  readonly negativeLagMode?: "hard" | "diagnostic";
  /** Bucket width, in minutes, for the wrong-day-matched-time placebo and its diversity check. */
  readonly matchedTimeBucketMinutes?: number;
  /**
   * Below this fraction of observations sitting in a time-of-day bucket with real day-to-day
   * diversity, the wrong-day-matched-time placebo is treated as degenerate (see the header) and the
   * verdict becomes `INCONCLUSIVE` rather than `NO_SIGNAL`/`PASS`.
   */
  readonly matchedTimeMinimumSwappableFraction?: number;
}

export type FalsificationVerdict =
  | "PASS"
  | "NO_SIGNAL"
  | "INSUFFICIENT_SAMPLE"
  | "INCONCLUSIVE"
  | "FAIL_LOOKAHEAD"
  | "FAIL_PLACEBO"
  | "FAIL_NEGATIVE_LAG";

export interface LaggedIc {
  readonly lag: number;
  readonly ic: number | null;
  readonly sampleSize: number;
}

export interface PlaceboIc {
  readonly placebo: string;
  readonly ic: number | null;
  readonly sampleSize: number;
  /**
   * True when this placebo's own bucketing/shuffling had too little real diversity to trust its IC
   * — currently only possible for `wrong-day-matched-time` (see the header). A degenerate placebo is
   * excluded from `placeboBand` and forces the whole verdict to `INCONCLUSIVE`.
   */
  readonly degenerate?: boolean;
}

export interface FalsificationReport {
  readonly sampleSize: number;
  readonly lookaheadViolations: readonly LookaheadViolation[];
  readonly real: InformationCoefficient;
  readonly negativeLagIcs: readonly LaggedIc[];
  readonly placeboIcs: readonly PlaceboIc[];
  /** Largest absolute placebo IC. The bar the real IC must clear. Null when none was measurable. */
  readonly placeboBand: number | null;
  /**
   * The bar a negative lag must clear to be called skew: `max(placeboBand, sigma / sqrt(n - 1))`.
   * Deliberately not `placeboBand` — see the header.
   */
  readonly negativeLagThreshold: number | null;
  readonly verdict: FalsificationVerdict;
  /** Human-readable reasons, empty on PASS. */
  readonly failures: readonly string[];
  /** Diagnostics for the wrong-day-matched-time placebo's own day-diversity, null before it runs. */
  readonly matchedTimeDiversity: MatchedTimeDiversity | null;
}

const DEFAULT_NEGATIVE_LAGS = [-1, -3, -10, -30] as const;

/** Pairs feature[i] with forwardReturn[i + lag]; lag 0 is the natural pairing. */
function alignAtLag(
  observations: readonly FalsificationObservation[],
  lag: number,
): { feature: number[]; forwardReturn: number[] } {
  const feature: number[] = [];
  const forwardReturn: number[] = [];
  for (let index = 0; index < observations.length; index += 1) {
    const partner = index + lag;
    if (partner < 0 || partner >= observations.length) continue;
    const observation = observations[index]!;
    const partnerObservation = observations[partner]!;
    // On overlapping decision grids, row i-1's "forward" return can still end after row i's
    // decision. Calling that a past return manufactured a negative-lag failure for every 15m+
    // target. A lag probe is causal only when the paired label was fully resolved by this decision.
    if (
      lag < 0
      && partnerObservation.labelEndAt
      && partnerObservation.labelEndAt.getTime() > observation.at.getTime()
    ) continue;
    feature.push(observation.featureValue);
    forwardReturn.push(partnerObservation.forwardReturn);
  }
  return { feature, forwardReturn };
}

function absOrNull(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

export function runFalsificationHarness(
  observations: readonly FalsificationObservation[],
  options: FalsificationOptions = {},
): FalsificationReport {
  const seed = options.seed ?? 1;
  const bootstrapSamples = options.bootstrapSamples ?? 1_000;
  const minimumSample = options.minimumSample ?? 100;
  const negativeLags = options.negativeLags ?? DEFAULT_NEGATIVE_LAGS;
  const blockSize = options.blockSize ?? Math.max(2, Math.floor(observations.length / 20));
  const circularShift = options.circularShift
    ?? Math.max(1, Math.floor(observations.length / 3));

  const failures: string[] = [];

  // --- Every observation must be point-in-time before anything is measured ----------------
  const lookaheadViolations = findLookaheadViolations(
    observations.map((observation, index) => ({
      label: `observation[${index}] at ${
        observation.at instanceof Date && !Number.isNaN(observation.at.getTime())
          ? observation.at.toISOString()
          : "invalid date"
      }`,
      featureAsOf: observation.featureAsOf,
      decidedAt: observation.at,
    })),
  );

  const natural = alignAtLag(observations, 0);
  const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
  const dayKeys = observations.map((observation) => (
    observation.at instanceof Date && !Number.isNaN(observation.at.getTime())
      ? dayFormatter.format(observation.at)
      : "INVALID"
  ));
  const real = informationCoefficient(natural.feature, natural.forwardReturn, {
    bootstrapSamples,
    seed,
    dayKeys,
  });

  // A look-ahead violation corrupts every number below it, so the report stops describing a signal
  // and starts describing a bug.
  if (lookaheadViolations.length > 0) {
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations,
      real,
      negativeLagIcs: [],
      placeboIcs: [],
      placeboBand: null,
      negativeLagThreshold: null,
      verdict: "FAIL_LOOKAHEAD",
      failures: [
        `${lookaheadViolations.length} of ${observations.length} observations are not `
        + `point-in-time (first: ${lookaheadViolations[0]!.message}). No IC is reported as `
        + "meaningful, because evidence from the future corrupts every lag equally.",
      ],
      matchedTimeDiversity: null,
    };
  }

  if (real.sampleSize < minimumSample) {
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs: [],
      placeboIcs: [],
      placeboBand: null,
      negativeLagThreshold: null,
      verdict: "INSUFFICIENT_SAMPLE",
      failures: [
        `${real.sampleSize} usable pairs is below the pre-declared minimum of ${minimumSample}. `
        + "Reporting an IC here would be a peek, not a measurement.",
      ],
      matchedTimeDiversity: null,
    };
  }

  // --- Placebos: each destroys a different thing; see placebos.ts -------------------------
  const timestamped = observations.map((observation) => ({
    at: observation.at,
    value: observation.featureValue,
  }));

  const matchedTimeBucketMinutes = options.matchedTimeBucketMinutes ?? 15;
  const matchedTimeMinimumSwappableFraction = options.matchedTimeMinimumSwappableFraction
    ?? DEFAULT_MINIMUM_SWAPPABLE_FRACTION;
  // Measured on the same timestamped series the placebo itself shuffles, so the diagnostic and the
  // shuffle can never disagree about which buckets had a day to swap with.
  const dayDiversity = matchedTimeDiversity(
    timestamped,
    matchedTimeBucketMinutes,
    matchedTimeMinimumSwappableFraction,
  );

  const placeboSeries: Array<{ placebo: string; feature: number[]; degenerate?: boolean }> = [
    { placebo: "sign-flip", feature: signFlipped(natural.feature, seed + 11) },
    { placebo: "block-permutation", feature: blockPermuted(natural.feature, blockSize, seed + 22) },
    { placebo: "circular-shift", feature: circularShifted(natural.feature, circularShift) },
    {
      placebo: "wrong-day-matched-time",
      feature: wrongDayMatchedTime(timestamped, seed + 33, matchedTimeBucketMinutes)
        .slice(0, natural.feature.length),
      degenerate: dayDiversity.isDegenerate,
    },
  ];

  const placeboIcs: PlaceboIc[] = placeboSeries.map(({ placebo, feature, degenerate }) => {
    const measured = informationCoefficient(feature, natural.forwardReturn, {
      bootstrapSamples: 0,
      seed,
    });
    return { placebo, ic: measured.ic, sampleSize: measured.sampleSize, degenerate };
  });

  // A degenerate placebo's IC is not a placebo result -- it must not silently set or inflate the
  // band the real IC has to clear. See the header on why this forces INCONCLUSIVE below rather than
  // being dropped quietly.
  const measurableBands = placeboIcs
    .filter((entry) => !entry.degenerate)
    .map((entry) => absOrNull(entry.ic))
    .filter((value): value is number => value !== null);
  const placeboBand = measurableBands.length === 0 ? null : Math.max(...measurableBands);

  // --- Negative lags: the future cannot inform the past ------------------------------------
  const negativeLagIcs: LaggedIc[] = negativeLags.map((lag) => {
    const aligned = alignAtLag(observations, lag);
    const measured = informationCoefficient(aligned.feature, aligned.forwardReturn, {
      bootstrapSamples: 0,
      seed,
    });
    return { lag, ic: measured.ic, sampleSize: measured.sampleSize };
  });

  // The analytic null noise floor of a rank correlation, which the placebo band can fall below on a
  // clean feature. See the header: judging one noisy lag draw against a tight band fails good data.
  const nullStandardError = real.sampleSize > 1 ? 1 / Math.sqrt(real.sampleSize - 1) : null;
  const noiseFloor = nullStandardError === null
    ? null
    : (options.negativeLagSigma ?? 3) * nullStandardError;
  const negativeLagThreshold = placeboBand === null
    ? noiseFloor
    : Math.max(placeboBand, noiseFloor ?? 0);

  // --- Verdict, in order of what invalidates what ------------------------------------------
  if (placeboBand === null) {
    failures.push(
      "No placebo produced a measurable IC, so there is no band to judge the real IC against. "
      + "This usually means the feature is constant or near-constant.",
    );
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "FAIL_PLACEBO",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  const realMagnitude = absOrNull(real.ic);
  if (realMagnitude === null) {
    failures.push(
      "The real IC is unmeasurable (a constant feature or return series), which is a pipeline "
      + "problem rather than a negative result.",
    );
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "FAIL_PLACEBO",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  // The wrong-day-matched-time placebo could not be trusted on this window (see the header). Every
  // downstream check below assumes a trustworthy placebo band, so this must be decided before any of
  // them -- an untrustworthy instrument does not get to hand out a NO_SIGNAL or a PASS.
  if (dayDiversity.isDegenerate) {
    failures.push(
      `The wrong-day-matched-time placebo is degenerate: only `
      + `${(dayDiversity.swappableFraction * 100).toFixed(1)}% of observations sat in a `
      + `${matchedTimeBucketMinutes}-minute time-of-day bucket with at least 2 distinct calendar days `
      + `to swap between (minimum ${(matchedTimeMinimumSwappableFraction * 100).toFixed(0)}%, `
      + `${dayDiversity.distinctDays} distinct day(s) seen overall). Its IC is not a placebo result -- `
      + "it is the real IC measured again on an unshuffled series -- so this window's verdict is "
      + "withheld rather than reported as a real NO_SIGNAL or PASS.",
    );
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "INCONCLUSIVE",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  const breachingLags = negativeLagIcs.filter((entry) => {
    const magnitude = absOrNull(entry.ic);
    // A horizon-overlap filter can leave only a handful of overnight boundary pairs for a short
    // offset. Judging that tiny remainder against the full-sample noise floor recreates the false
    // failure through small-n variance, so a lag must independently clear the declared sample floor.
    return entry.sampleSize >= minimumSample
      && magnitude !== null
      && negativeLagThreshold !== null
      && magnitude > negativeLagThreshold;
  });
  if (breachingLags.length > 0 && (options.negativeLagMode ?? "hard") === "hard") {
    for (const entry of breachingLags) {
      failures.push(
        `Negative lag ${entry.lag} produced |IC| ${Math.abs(entry.ic!).toFixed(4)}, above the `
        + `skew threshold of ${negativeLagThreshold!.toFixed(4)}. The feature appears to predict a `
        + "return that "
        + "already happened, which indicates timestamp skew, a stale feature, or a join off by one "
        + "-- not an edge. The positive-lag result is void for the same reason.",
      );
    }
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "FAIL_NEGATIVE_LAG",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  if (realMagnitude <= placeboBand) {
    failures.push(
      `The real |IC| of ${realMagnitude.toFixed(4)} does not exceed the placebo band of `
      + `${placeboBand.toFixed(4)}. A signal that scores no better than its own destroyed labels is `
      + "measuring the harness, not the market.",
    );
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "NO_SIGNAL",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  // A CI straddling zero is reported as NO_SIGNAL even having cleared the band: beating the placebos
  // on a point estimate while being unstable under resampling is not a result worth carrying forward.
  if (real.confidenceInterval && real.confidenceInterval.lower <= 0 && real.confidenceInterval.upper >= 0) {
    failures.push(
      `The real IC of ${real.ic!.toFixed(4)} clears the placebo band but its bootstrap interval `
      + `[${real.confidenceInterval.lower.toFixed(4)}, ${real.confidenceInterval.upper.toFixed(4)}] `
      + "contains zero, so the relationship is not stable under resampling.",
    );
    return {
      sampleSize: real.sampleSize,
      lookaheadViolations: [],
      real,
      negativeLagIcs,
      placeboIcs,
      placeboBand,
      negativeLagThreshold,
      verdict: "NO_SIGNAL",
      failures,
      matchedTimeDiversity: dayDiversity,
    };
  }

  return {
    sampleSize: real.sampleSize,
    lookaheadViolations: [],
    real,
    negativeLagIcs,
    placeboIcs,
    placeboBand,
    negativeLagThreshold,
    verdict: "PASS",
    failures: [],
    matchedTimeDiversity: dayDiversity,
  };
}
