import { matchedControlCount } from "./matched-controls.js";

/**
 * The three Section-4 estimands, plus the day-clustered inference they are read through.
 *
 * The harness up to this point is a data factory: it captures proposals, groups them into
 * opportunities, matches outcome-blind controls, and settles every subject. None of that answers the
 * research question. These functions are the layer that turns settled rows into an estimate — and,
 * more importantly, into an *interval*, because a point estimate of edge with no uncertainty attached
 * has repeatedly been the thing that made a dead strategy look alive in this project.
 *
 * ## Why day clustering rather than treating trades as independent
 *
 * Intraday scalp outcomes inside one session are emphatically not independent draws: they share a
 * regime, a trend, a volatility level, and often overlapping forward windows. Treating each unit as
 * independent understates the variance — badly — and produces confidence intervals that exclude zero
 * on noise alone. So the resampling unit here is the *trading day*: a bootstrap replicate resamples
 * whole days with replacement, keeping every unit inside a day together. This is the standard block
 * bootstrap for clustered dependence, and it is deliberately conservative.
 *
 * ## What is excluded, and why that is not a filter on outcomes
 *
 * A unit with a null outcome (AMBIGUOUS, DATA_INCOMPLETE, POLICY_INVALID, or — for the
 * conditional-on-entry reading — a non-triggered entry) contributes nothing, and a treated unit
 * without full common support (fewer than the frozen control count) is dropped by the matcher before
 * it ever reaches here. Both exclusions are decided by settlement policy and matching policy, never
 * by whether the outcome was favourable, so they cannot tilt the estimate. The counts are reported so
 * the reader can see how much of the population the estimate actually rests on.
 */

/**
 * The immutable strategy definitions a unit was produced under.
 *
 * Version immutability is enforced at storage — a changed configuration yields a new definition hash —
 * but that guarantee is defeated at the analytics layer the moment two definitions are averaged into
 * one number. A gated population and an ungated one answer different questions, and pooling them
 * silently reports a strategy that never existed. So every unit carries its provenance and the
 * estimators partition on it rather than trusting the caller to filter.
 */
export interface CohortTagged {
  readonly strategyDefinitionHashes: readonly string[];
}

/** Stable cohort identity: the definition set, order-independent. */
export function cohortKeyOf(unit: CohortTagged): string {
  return [...new Set(unit.strategyDefinitionHashes)].sort().join("+") || "UNATTRIBUTED";
}

/** Groups units so a single estimate never spans more than one definition set. */
export function partitionByCohort<T extends CohortTagged>(units: readonly T[]): Map<string, T[]> {
  const cohorts = new Map<string, T[]>();
  for (const unit of units) {
    const key = cohortKeyOf(unit);
    const bucket = cohorts.get(key);
    if (bucket) bucket.push(unit);
    else cohorts.set(key, [unit]);
  }
  return cohorts;
}

/**
 * Refuses a set of units that spans more than one definition cohort.
 *
 * Deliberately a throw rather than a warning: a pooled estimate looks entirely normal in a report, so
 * a soft signal would be read past. Pooling stays possible, but only by an explicit caller decision.
 */
export function assertSingleCohort(units: readonly CohortTagged[]): void {
  const cohorts = new Set(units.map(cohortKeyOf));
  if (cohorts.size > 1) {
    throw new Error(
      `Refusing to estimate across ${cohorts.size} strategy-definition cohorts: ${[...cohorts].join(", ")}. `
      + "Partition with partitionByCohort, or pool only under an explicit study manifest.",
    );
  }
}

/** A settled treated unit paired with its matched control outcomes. */
export interface SignalEdgeUnit extends CohortTagged {
  readonly opportunityId: string;
  /** IST trading day (YYYY-MM-DD) — the bootstrap cluster. */
  readonly sessionId: string;
  /** Canonical outcome of the selected (treated) subject; null when not economically gradeable. */
  readonly selectedOutcomeR: number | null;
  /** Canonical outcomes of the matched controls, in matcher order. */
  readonly controlOutcomesR: readonly (number | null)[];
}

/** A native-policy outcome paired with the canonical outcome of the same opportunity. */
export interface PolicyEdgeUnit extends CohortTagged {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly nativeOutcomeR: number | null;
  readonly canonicalOutcomeR: number | null;
}

/**
 * One settled subject's outcome, for the absolute-expectancy gate.
 *
 * Distinct from `SignalEdgeUnit` in what it answers. Signal Edge is a *contrast* — selected against
 * matched controls — and friction largely cancels inside it. This is the level: what one subject of
 * this type actually returned. Both are needed and neither substitutes for the other. A strategy can
 * post a positive Signal Edge while its absolute expectancy is negative (it picks better-than-random
 * moments in a market that pays nothing), and that combination is not tradeable however good the
 * contrast looks.
 */
export interface AbsoluteExpectancyUnit extends CohortTagged {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly outcomeR: number | null;
}

/** A settled outcome tagged with the observational risk verdict that was recorded for it. */
export interface GateValueUnit extends CohortTagged {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly outcomeR: number | null;
  readonly decision: "ALLOW" | "REJECT";
}

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

export interface EstimateSummary {
  /** Units that contributed to the estimate (null outcomes and unsupported units excluded). */
  readonly units: number;
  /** Distinct trading days spanned — the effective sample size for clustered inference. */
  readonly days: number;
  readonly meanPerUnit: number | null;
  /** Mean of per-day means; the quantity the bootstrap resamples, so the CI belongs to this. */
  readonly meanPerDay: number | null;
  readonly ci95: Interval | null;
  readonly excludedUnits: number;
}

export interface BootstrapOptions {
  /** Replicates. More is tighter but slower; 2000 is the usual floor for a stable 95% interval. */
  readonly replicates?: number;
  /** Deterministic seed, so an estimate is reproducible from the same rows. */
  readonly seed?: string;
}

const defaultReplicates = 2000;

/**
 * Deterministic uniform stream (mulberry32 over a hashed seed).
 *
 * A research estimate must be reproducible from its inputs — `Math.random` would make two runs over
 * identical rows disagree, which is indistinguishable from a data change when reading a report.
 */
function seededUniform(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Groups unit-level contributions by trading day — the cluster the bootstrap resamples. */
function byDay(units: readonly { sessionId: string; value: number }[]): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const unit of units) {
    const bucket = grouped.get(unit.sessionId);
    if (bucket) bucket.push(unit.value);
    else grouped.set(unit.sessionId, [unit.value]);
  }
  return grouped;
}

/**
 * Summarises per-unit contributions with a trading-day block bootstrap.
 *
 * The statistic is the mean of per-day means rather than the pooled per-unit mean, so a single busy
 * day cannot dominate the estimate — days are the independent unit, and each should carry equal
 * weight. The interval is the percentile interval over the replicate distribution.
 */
export function summariseByDayBootstrap(
  contributions: readonly { sessionId: string; value: number }[],
  excludedUnits: number,
  options: BootstrapOptions = {},
): EstimateSummary {
  const grouped = byDay(contributions);
  const dayKeys = [...grouped.keys()].sort();
  const dayMeans = dayKeys.map((key) => mean(grouped.get(key)!)!);
  const units = contributions.length;

  const summary = {
    units,
    days: dayKeys.length,
    meanPerUnit: mean(contributions.map((item) => item.value)),
    meanPerDay: mean(dayMeans),
    excludedUnits,
  };
  // One day cannot express between-day variance, so an interval would be a fabricated precision.
  if (dayKeys.length < 2) return { ...summary, ci95: null };

  const replicates = options.replicates ?? defaultReplicates;
  const next = seededUniform(options.seed ?? "scalp-research-bootstrap-v1");
  const replicateMeans: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let total = 0;
    // Resample whole days with replacement: every unit inside a drawn day travels with it, which is
    // what preserves the within-day dependence the clustering exists to respect.
    for (let draw = 0; draw < dayKeys.length; draw += 1) {
      total += dayMeans[Math.floor(next() * dayKeys.length)]!;
    }
    replicateMeans.push(total / dayKeys.length);
  }
  replicateMeans.sort((left, right) => left - right);
  const at = (quantile: number): number =>
    replicateMeans[Math.min(replicateMeans.length - 1, Math.max(0, Math.floor(quantile * replicateMeans.length)))]!;
  return { ...summary, ci95: { lower: at(0.025), upper: at(0.975) } };
}

/**
 * SIGNAL EDGE — `selectedCanonicalOutcome_i - mean(matchedControlOutcomes_i)`.
 *
 * A unit contributes only when the treated outcome and every one of its frozen-count controls is
 * economically gradeable. Requiring the full control set (rather than averaging whatever survived)
 * keeps the comparison a like-for-like contrast: a unit whose controls partly failed to settle would
 * otherwise be measured against a different, smaller baseline than its peers.
 */
export function estimateSignalEdge(
  units: readonly SignalEdgeUnit[],
  options: BootstrapOptions = {},
): EstimateSummary {
  assertSingleCohort(units);
  const contributions: { sessionId: string; value: number }[] = [];
  let excluded = 0;
  for (const unit of units) {
    const controls = unit.controlOutcomesR.filter((value): value is number => value !== null);
    if (unit.selectedOutcomeR === null
      || controls.length !== matchedControlCount
      || unit.controlOutcomesR.length !== matchedControlCount) {
      excluded += 1;
      continue;
    }
    contributions.push({ sessionId: unit.sessionId, value: unit.selectedOutcomeR - mean(controls)! });
  }
  return summariseByDayBootstrap(contributions, excluded, { seed: "signal-edge-v1", ...options });
}

/**
 * ABSOLUTE EXPECTANCY — the mean outcome of one subject type, with no contrast.
 *
 * This is the early-stopping gate. Before any TP/SL/timeout search is worth running, the population
 * being searched has to have somewhere to go: if the mean gross outcome of the proposals is
 * indistinguishable from zero, no choice of exit policy recovers it, and a wide enough sweep will
 * nonetheless return a profitable-looking cell by chance. Sweeping first and gating afterwards gets
 * that ordering exactly backwards, which is how parameter mining happens.
 *
 * Read against the same estimate computed for `CONTROL_POINT` subjects. Controls are outcome-blind
 * draws from the same sessions, so they measure what the market paid anyone who showed up; the
 * proposals have to beat that, not merely beat zero.
 *
 * Deliberately not a difference. `estimateSignalEdge` already provides the paired contrast with its
 * variance advantage — this reports the *level*, which the contrast cannot, and the level is what
 * decides tradeability.
 */
export function estimateAbsoluteExpectancy(
  units: readonly AbsoluteExpectancyUnit[],
  options: BootstrapOptions = {},
): EstimateSummary {
  assertSingleCohort(units);
  const contributions: { sessionId: string; value: number }[] = [];
  let excluded = 0;
  for (const unit of units) {
    if (unit.outcomeR === null || !Number.isFinite(unit.outcomeR)) {
      excluded += 1;
      continue;
    }
    contributions.push({ sessionId: unit.sessionId, value: unit.outcomeR });
  }
  return summariseByDayBootstrap(contributions, excluded, { seed: "absolute-expectancy-v1", ...options });
}

/**
 * NATIVE EXECUTION POLICY EDGE — paired `native - canonical` on the same opportunity.
 *
 * Pairing is what isolates the execution policy: both sides see the identical signal at the identical
 * moment, so the difference is attributable to the native entry/exit policy rather than to which
 * signals happened to fire. The caller decides the intent-to-trade vs conditional-on-entry reading by
 * how it derives `nativeOutcomeR` (see `nativeOutcomeR` in settlement), and the two readings answer
 * different questions — do not mix them in one estimate.
 */
export function estimateNativePolicyEdge(
  units: readonly PolicyEdgeUnit[],
  options: BootstrapOptions = {},
): EstimateSummary {
  assertSingleCohort(units);
  const contributions: { sessionId: string; value: number }[] = [];
  let excluded = 0;
  for (const unit of units) {
    if (unit.nativeOutcomeR === null || unit.canonicalOutcomeR === null) {
      excluded += 1;
      continue;
    }
    contributions.push({ sessionId: unit.sessionId, value: unit.nativeOutcomeR - unit.canonicalOutcomeR });
  }
  return summariseByDayBootstrap(contributions, excluded, { seed: "native-policy-edge-v1", ...options });
}

export interface GateValueSummary {
  readonly allow: EstimateSummary;
  readonly reject: EstimateSummary;
  /** ALLOW minus REJECT, on day means. Observational: the gate did not randomise these groups. */
  readonly difference: number | null;
  readonly interpretation: string;
}

/**
 * GATE VALUE — shadow outcomes segmented by the observational risk verdict.
 *
 * Explicitly *not* causal, and the returned `interpretation` says so on every result. The risk gate
 * chose which subjects it would have allowed using information correlated with the outcome, so the
 * ALLOW/REJECT gap mixes any real gate skill with plain selection. It is reported because a gate that
 * cannot separate outcomes even observationally is definitely not worth promoting — a useful negative
 * screen, never evidence that gating causes the difference.
 */
export function estimateGateValue(
  units: readonly GateValueUnit[],
  options: BootstrapOptions = {},
): GateValueSummary {
  assertSingleCohort(units);
  const split = (decision: "ALLOW" | "REJECT"): EstimateSummary => {
    const contributions: { sessionId: string; value: number }[] = [];
    let excluded = 0;
    for (const unit of units.filter((item) => item.decision === decision)) {
      if (unit.outcomeR === null) { excluded += 1; continue; }
      contributions.push({ sessionId: unit.sessionId, value: unit.outcomeR });
    }
    return summariseByDayBootstrap(contributions, excluded, { seed: `gate-${decision.toLowerCase()}-v1`, ...options });
  };
  const allow = split("ALLOW");
  const reject = split("REJECT");
  return {
    allow,
    reject,
    difference: allow.meanPerDay === null || reject.meanPerDay === null
      ? null
      : allow.meanPerDay - reject.meanPerDay,
    interpretation: "OBSERVATIONAL_NON_CAUSAL — ALLOW and REJECT are not randomised groups; "
      + "this difference confounds gate skill with selection and must not be read as a treatment effect.",
  };
}
