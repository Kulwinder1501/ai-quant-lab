/**
 * How many *independent* observations a pooled model's settled rows are actually worth.
 *
 * The volatility promotion margin (0.088) was derived as two standard errors of a macro-F1
 * difference at ~250 rows per side, which assumes those rows are independent. They are not, and for
 * two compounding reasons rather than one:
 *
 * - **Cross-sectional.** A pooled model writes a row per instrument, and twenty correlated names in
 *   one market share most of their systematic variance.
 * - **Serial.** On an intraday timeframe it also writes a row per *bar*. Measured 2026-08-10, the
 *   enrolled 15m pool-2 models each held 14 settled rows across 2 instruments -- seven bars per
 *   instrument per session -- and a 1m single-instrument model held 21. Overlapping windows of the
 *   same instrument hours apart are the most correlated rows in the set, and a roster-size argument
 *   does not see them at all.
 *
 * Clustering on the session absorbs both, which is why the session is the unit here. So the row
 * count overstates the evidence by an amount nobody had measured -- which left the session gates in
 * `volatility-competition.ts` calibrated on an assumption rather than a number.
 *
 * This module measures it. Three things, in increasing order of directness:
 *
 * 1. **Intraclass correlation** of per-row correctness within a session, by one-way ANOVA. This is
 *    the clustering itself: how much of the variation in whether a prediction was right is a
 *    property of the day rather than of the instrument.
 * 2. **Design effect and effective sample size.** `DEFF = 1 + (m - 1) * rho` for average cluster
 *    size `m`; `ESS = rows / DEFF`. At rho = 0 the rows are independent and ESS is the row count;
 *    at rho = 1 a session's rows carry one observation between them and ESS is the session count.
 * 3. **A session block bootstrap** of macro-F1 and of the paired difference between two models.
 *    This is the number the margin should actually be set from, because it needs no distributional
 *    assumption and it respects both effects that matter -- see below.
 *
 * ## Why the bootstrap, and not just DEFF
 *
 * Two forces push in opposite directions and the original derivation captured neither.
 *
 * Clustering inflates the standard error, so a margin set on the row count is too small. But two
 * models in a competition score the *same rows*, and their errors are positively correlated --
 * they see the same market on the same day. For a paired comparison
 * `Var(a - b) = Var(a) + Var(b) - 2 Cov(a, b)`, so the `sqrt(2) * SE` in the original derivation
 * is itself an overestimate whenever the models agree at all. Resampling whole sessions and
 * recomputing the difference measures the net of the two directly, on the actual scored rows,
 * instead of composing two assumptions and hoping they cancel.
 *
 * Sessions are the resampling unit because the session is the plausible independent unit. That is
 * deliberately the conservative choice: if instruments within a day were in fact independent, this
 * overstates the uncertainty. Overstating it delays a promotion; understating it makes one on noise.
 */

/** One settled row, reduced to what the statistics need. */
export interface SettledRow {
  /** Cluster key. An IST calendar date in practice; treated only as an opaque grouping. */
  session: string;
  prediction: string;
  realizedLabel: string;
}

export interface ClusterOutcome {
  size: number;
  /** Mean of the 0/1 correctness indicator inside the cluster. */
  mean: number;
}

/** Groups rows into per-session correctness clusters. */
export function toClusters(rows: readonly SettledRow[]): ClusterOutcome[] {
  const bySession = new Map<string, { size: number; correct: number }>();
  for (const row of rows) {
    const bucket = bySession.get(row.session) ?? { size: 0, correct: 0 };
    bucket.size += 1;
    if (row.prediction === row.realizedLabel) bucket.correct += 1;
    bySession.set(row.session, bucket);
  }
  return [...bySession.values()].map((bucket) => ({
    size: bucket.size,
    mean: bucket.correct / bucket.size,
  }));
}

export interface IntraclassCorrelation {
  /** ANOVA estimate, clamped to [0, 1]. Null when the design cannot support one. */
  rho: number | null;
  clusters: number;
  rows: number;
  /** Mean cluster size, and the size ANOVA uses for unequal clusters. */
  meanClusterSize: number;
  refusal: string | null;
}

/**
 * One-way random-effects ICC of the correctness indicator, for unequal cluster sizes.
 *
 * The 0/1 outcome makes the within-cluster sum of squares exact rather than estimated:
 * `sum (x - p)^2` over a cluster of `m` zero-or-one values with mean `p` is `m * p * (1 - p)`.
 *
 * A negative ANOVA estimate is clamped to 0. That happens when between-cluster variation is
 * smaller than chance would produce, which is evidence *against* clustering, not evidence of
 * anti-correlation worth propagating into a design effect below 1.
 */
export function intraclassCorrelation(rows: readonly SettledRow[]): IntraclassCorrelation {
  const clusters = toClusters(rows);
  const clusterCount = clusters.length;
  const rowCount = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
  const meanClusterSize = clusterCount === 0 ? 0 : rowCount / clusterCount;

  const base = { clusters: clusterCount, rows: rowCount, meanClusterSize };
  if (clusterCount < 2) {
    return {
      ...base,
      rho: null,
      refusal: `Intraclass correlation needs at least 2 sessions; found ${clusterCount}.`,
    };
  }
  if (rowCount <= clusterCount) {
    return {
      ...base,
      rho: null,
      refusal: "Every session holds at most one row, so within-session variance is unmeasurable. "
        + "A single-instrument model has no clustering to estimate.",
    };
  }

  const grandMean = clusters.reduce((sum, c) => sum + c.size * c.mean, 0) / rowCount;
  const withinSumSquares = clusters.reduce((sum, c) => sum + c.size * c.mean * (1 - c.mean), 0);
  const betweenSumSquares = clusters.reduce(
    (sum, c) => sum + c.size * (c.mean - grandMean) ** 2,
    0,
  );

  const withinDf = rowCount - clusterCount;
  const betweenDf = clusterCount - 1;
  const withinMeanSquare = withinSumSquares / withinDf;
  const betweenMeanSquare = betweenSumSquares / betweenDf;

  // The ANOVA cluster size for unequal groups, not the arithmetic mean.
  const sumSquaredSizes = clusters.reduce((sum, c) => sum + c.size ** 2, 0);
  const anovaClusterSize = (rowCount - sumSquaredSizes / rowCount) / betweenDf;

  const denominator = betweenMeanSquare + (anovaClusterSize - 1) * withinMeanSquare;
  if (denominator <= 0) {
    // Both mean squares are zero: every row in every session was correct, or every one wrong.
    // There is no variance to partition, so no correlation is identifiable.
    return {
      ...base,
      rho: null,
      refusal: "Correctness is constant across every row, so no variance exists to partition.",
    };
  }

  const raw = (betweenMeanSquare - withinMeanSquare) / denominator;
  return { ...base, rho: Math.min(1, Math.max(0, raw)), refusal: null };
}

export interface EffectiveSample {
  rows: number;
  sessions: number;
  rho: number | null;
  /** Variance inflation from clustering. 1 means the rows were independent. */
  designEffect: number | null;
  /** Rows divided by the design effect. Bounded below by the session count. */
  effectiveSampleSize: number | null;
  refusal: string | null;
}

/**
 * Rows, discounted for clustering.
 *
 * Floored at the session count: whatever the estimate says, a model that scored on fifteen days
 * has not made fewer than fifteen quasi-independent observations, and reporting an ESS below the
 * cluster count would be an artefact of the estimator rather than a fact about the data.
 */
export function effectiveSampleSize(rows: readonly SettledRow[]): EffectiveSample {
  const icc = intraclassCorrelation(rows);
  if (icc.rho === null) {
    return {
      rows: icc.rows,
      sessions: icc.clusters,
      rho: null,
      designEffect: null,
      effectiveSampleSize: null,
      refusal: icc.refusal,
    };
  }
  const designEffect = 1 + (icc.meanClusterSize - 1) * icc.rho;
  const ess = Math.max(icc.clusters, icc.rows / designEffect);
  return {
    rows: icc.rows,
    sessions: icc.clusters,
    rho: icc.rho,
    designEffect,
    effectiveSampleSize: ess,
    refusal: null,
  };
}

/** Deterministic PRNG, so a reported standard error is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface ConfusionCount {
  prediction: string;
  realizedLabel: string;
  count: number;
}

/** Rows to confusion counts, so a caller's existing metric function can consume them. */
export function toConfusionCounts(rows: readonly SettledRow[]): ConfusionCount[] {
  const byCell = new Map<string, ConfusionCount>();
  for (const row of rows) {
    const key = `${row.prediction} ${row.realizedLabel}`;
    const cell = byCell.get(key);
    if (cell) cell.count += 1;
    else byCell.set(key, { prediction: row.prediction, realizedLabel: row.realizedLabel, count: 1 });
  }
  return [...byCell.values()];
}

export interface BootstrapOptions {
  /** Resamples. 2000 is enough for a standard error to two significant figures. */
  resamples?: number;
  seed?: number;
  /** Below this many sessions the estimate is refused rather than reported. */
  minimumSessions?: number;
}

export interface BootstrapResult {
  standardError: number | null;
  /** Percentile interval of the resampled statistic, for reporting alongside the SE. */
  percentile025: number | null;
  percentile975: number | null;
  resamples: number;
  sessions: number;
  refusal: string | null;
}

const DEFAULT_RESAMPLES = 2_000;
const DEFAULT_SEED = 20_260_810;
/**
 * Ten sessions to attempt a session bootstrap.
 *
 * Not a statistical threshold so much as a floor on absurdity: resampling three sessions with
 * replacement produces a standard error whose own uncertainty exceeds the quantity, and reporting
 * it would invite exactly the false precision this measurement exists to remove.
 */
export const MINIMUM_BOOTSTRAP_SESSIONS = 10;

function groupBySession(rows: readonly SettledRow[]): SettledRow[][] {
  const bySession = new Map<string, SettledRow[]>();
  for (const row of rows) {
    const bucket = bySession.get(row.session);
    if (bucket) bucket.push(row);
    else bySession.set(row.session, [row]);
  }
  // Sorted, so a fixed seed gives a fixed answer regardless of row arrival order.
  return [...bySession.keys()].sort().map((key) => bySession.get(key)!);
}

function summarise(samples: readonly number[], sessions: number, resamples: number): BootstrapResult {
  if (samples.length < 2) {
    return {
      standardError: null,
      percentile025: null,
      percentile975: null,
      resamples,
      sessions,
      refusal: "Too few resamples produced a defined statistic to estimate a standard error.",
    };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))
  ]!;
  return {
    standardError: Math.sqrt(variance),
    percentile025: at(0.025),
    percentile975: at(0.975),
    resamples,
    sessions,
    refusal: null,
  };
}

/**
 * Standard error of a whole-sample statistic, by resampling sessions with replacement.
 *
 * `statistic` receives the resampled rows as confusion counts, and returns null when it is
 * undefined for that resample -- a macro-F1 needs at least one row, and a resample that happens to
 * draw only sessions with a single class is legitimately undefined. Those are dropped rather than
 * substituted with zero, which would drag the standard error toward a number no data supports.
 */
export function sessionBlockBootstrap(
  rows: readonly SettledRow[],
  statistic: (counts: readonly ConfusionCount[]) => number | null,
  options: BootstrapOptions = {},
): BootstrapResult {
  const sessions = groupBySession(rows);
  const minimumSessions = options.minimumSessions ?? MINIMUM_BOOTSTRAP_SESSIONS;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  if (sessions.length < minimumSessions) {
    return {
      standardError: null,
      percentile025: null,
      percentile975: null,
      resamples: 0,
      sessions: sessions.length,
      refusal: `A session bootstrap needs at least ${minimumSessions} scored sessions; found `
        + `${sessions.length}. No standard error is reported rather than a meaningless one.`,
    };
  }

  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const samples: number[] = [];
  for (let index = 0; index < resamples; index += 1) {
    const drawn: SettledRow[] = [];
    for (let pick = 0; pick < sessions.length; pick += 1) {
      drawn.push(...sessions[Math.floor(random() * sessions.length)]!);
    }
    const value = statistic(toConfusionCounts(drawn));
    if (value !== null && Number.isFinite(value)) samples.push(value);
  }
  return summarise(samples, sessions.length, resamples);
}

/**
 * Standard error of the *paired* difference between two models, on their common sessions.
 *
 * Paired on purpose. Two competing models score the same market on the same days, so their errors
 * are positively correlated and the difference is measured far more precisely than either level.
 * Resampling the two independently, or comparing two separately-bootstrapped standard errors,
 * throws that away and reproduces the `sqrt(2) * SE` overestimate this is meant to replace.
 *
 * Only sessions both models scored are used, and the refusal says how many were dropped: a
 * difference measured over a window one side was absent from is not a comparison.
 */
export function pairedSessionBootstrap(
  left: readonly SettledRow[],
  right: readonly SettledRow[],
  statistic: (counts: readonly ConfusionCount[]) => number | null,
  options: BootstrapOptions = {},
): BootstrapResult & { commonSessions: number; droppedSessions: number } {
  const leftBySession = new Map<string, SettledRow[]>();
  for (const row of left) {
    const bucket = leftBySession.get(row.session);
    if (bucket) bucket.push(row); else leftBySession.set(row.session, [row]);
  }
  const rightBySession = new Map<string, SettledRow[]>();
  for (const row of right) {
    const bucket = rightBySession.get(row.session);
    if (bucket) bucket.push(row); else rightBySession.set(row.session, [row]);
  }

  const common = [...leftBySession.keys()].filter((key) => rightBySession.has(key)).sort();
  const dropped = new Set([...leftBySession.keys(), ...rightBySession.keys()]).size - common.length;
  const minimumSessions = options.minimumSessions ?? MINIMUM_BOOTSTRAP_SESSIONS;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;

  if (common.length < minimumSessions) {
    return {
      standardError: null,
      percentile025: null,
      percentile975: null,
      resamples: 0,
      sessions: common.length,
      commonSessions: common.length,
      droppedSessions: dropped,
      refusal: `A paired session bootstrap needs at least ${minimumSessions} sessions both models `
        + `scored; found ${common.length}.`,
    };
  }

  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const samples: number[] = [];
  for (let index = 0; index < resamples; index += 1) {
    const leftRows: SettledRow[] = [];
    const rightRows: SettledRow[] = [];
    for (let pick = 0; pick < common.length; pick += 1) {
      // The *same* session index feeds both sides, which is what keeps the comparison paired.
      const session = common[Math.floor(random() * common.length)]!;
      leftRows.push(...leftBySession.get(session)!);
      rightRows.push(...rightBySession.get(session)!);
    }
    const leftValue = statistic(toConfusionCounts(leftRows));
    const rightValue = statistic(toConfusionCounts(rightRows));
    if (
      leftValue !== null && rightValue !== null
      && Number.isFinite(leftValue) && Number.isFinite(rightValue)
    ) {
      samples.push(leftValue - rightValue);
    }
  }
  return {
    ...summarise(samples, common.length, resamples),
    commonSessions: common.length,
    droppedSessions: dropped,
  };
}

/**
 * The promotion margin a measured standard error supports, at two standard errors.
 *
 * Two rather than 1.96 to match the existing rules, whose 0.088 is stated as a
 * "two-standard-error filter". Rounded up to three decimals so the reported figure is never
 * marginally weaker than the measurement behind it.
 */
export function impliedPromotionMargin(standardErrorOfDifference: number): number {
  if (!Number.isFinite(standardErrorOfDifference) || standardErrorOfDifference < 0) {
    throw new Error("Standard error of a difference must be finite and non-negative.");
  }
  return Math.ceil(2 * standardErrorOfDifference * 1_000) / 1_000;
}
