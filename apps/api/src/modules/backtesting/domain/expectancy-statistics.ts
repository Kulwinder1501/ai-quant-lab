/**
 * Day-level expectancy statistics for Experiment A's selection rule.
 *
 * ## Why the unit of observation is the day, not the trade
 *
 * Trades inside one session are not independent: they read overlapping bars, share a regime, and a
 * trending morning produces a run of winners for one reason rather than many. Treating each trade as an
 * observation shrinks the standard error by roughly the square root of trades-per-day and manufactures
 * significance. A 1-minute architecture firing 40 times a session would look far more certain than a
 * 5-minute one firing 8, purely from the arithmetic.
 *
 * So each session contributes one number -- its mean net R -- and the confidence interval is taken over
 * those daily means. This is the protocol's declared criterion, and it is the reason a fast architecture
 * cannot buy significance with volume.
 *
 * ## Why deltas are paired
 *
 * The arms trade the same calendar. Comparing them as independent samples throws away the fact that a
 * bad Tuesday is bad for all three, which is the largest single source of shared variance. Pairing on
 * the session removes it, so the interval is about the architectures rather than about the year.
 */

export interface DailyExpectancy {
  /** IST session date, `YYYY-MM-DD`. */
  readonly day: string;
  readonly meanNetR: number;
  readonly trades: number;
}

export interface ExpectancySummary {
  readonly days: number;
  readonly trades: number;
  /** Mean of the daily means. Each session weighs the same regardless of how often it fired. */
  readonly meanDailyR: number;
  readonly standardError: number | null;
  readonly ci95: readonly [number, number] | null;
}

export interface PairedDelta {
  readonly label: string;
  readonly pairedDays: number;
  readonly meanDelta: number;
  readonly standardError: number | null;
  readonly ci95: readonly [number, number] | null;
  /** Two-sided p from a paired t statistic, normal-approximated. */
  readonly pValue: number | null;
  /** Set once Holm has been applied across the family. */
  holmAdjustedP?: number | null;
  /** True only when the Holm-adjusted interval excludes zero. */
  significant?: boolean;
}

/** Groups per-trade net outcomes into one observation per session. */
export function toDailyExpectancy(
  trades: readonly { readonly day: string; readonly netR: number }[],
): DailyExpectancy[] {
  const byDay = new Map<string, number[]>();
  for (const trade of trades) {
    const bucket = byDay.get(trade.day);
    if (bucket) bucket.push(trade.netR);
    else byDay.set(trade.day, [trade.netR]);
  }
  return [...byDay.entries()]
    .map(([day, values]) => ({
      day,
      meanNetR: values.reduce((sum, value) => sum + value, 0) / values.length,
      trades: values.length,
    }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

function meanAndStandardError(values: readonly number[]): { mean: number; standardError: number | null } {
  if (values.length === 0) return { mean: 0, standardError: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, standardError: null };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, standardError: Math.sqrt(variance / values.length) };
}

export function summariseExpectancy(daily: readonly DailyExpectancy[]): ExpectancySummary {
  const { mean, standardError } = meanAndStandardError(daily.map((entry) => entry.meanNetR));
  return {
    days: daily.length,
    trades: daily.reduce((sum, entry) => sum + entry.trades, 0),
    meanDailyR: mean,
    standardError,
    // 1.96 rather than a t quantile: with hundreds of sessions the difference is immaterial, and
    // stating the approximation is better than importing a t table for a third decimal place.
    ci95: standardError === null ? null : [mean - 1.96 * standardError, mean + 1.96 * standardError],
  };
}

/** Normal-approximated two-sided tail. Adequate at the day counts here (200+ sessions per period). */
function twoSidedP(t: number): number {
  const z = Math.abs(t);
  // Abramowitz & Stegun 7.1.26 for erf, which is accurate to ~1e-7 and needs no tables.
  const x = z / Math.SQRT2;
  const sign = 1;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const tt = 1 / (1 + p * x);
  const erf = sign * (1 - (((((a[4]! * tt + a[3]!) * tt) + a[2]!) * tt + a[1]!) * tt + a[0]!) * tt * Math.exp(-x * x));
  return Math.max(0, Math.min(1, 1 - erf));
}

/** Paired delta between two arms over the sessions both traded. */
export function pairedDelta(
  label: string,
  left: readonly DailyExpectancy[],
  right: readonly DailyExpectancy[],
): PairedDelta {
  const rightByDay = new Map(right.map((entry) => [entry.day, entry.meanNetR]));
  const differences: number[] = [];
  for (const entry of left) {
    const other = rightByDay.get(entry.day);
    if (other !== undefined) differences.push(entry.meanNetR - other);
  }
  const { mean, standardError } = meanAndStandardError(differences);
  return {
    label,
    pairedDays: differences.length,
    meanDelta: mean,
    standardError,
    ci95: standardError === null ? null : [mean - 1.96 * standardError, mean + 1.96 * standardError],
    pValue: standardError === null || standardError === 0 ? null : twoSidedP(mean / standardError),
  };
}

/**
 * Holm-Bonferroni across a family of contrasts, strongest evidence first.
 *
 * Holm rather than plain Bonferroni because it is uniformly more powerful at the same family-wise error
 * rate, and the protocol names it. `significant` is set only when the adjusted p clears 0.05 *and* the
 * unadjusted interval excludes zero -- the protocol's rule is about the interval, and reporting a
 * significant p beside an interval containing zero would be contradictory.
 */
export function applyHolm(deltas: readonly PairedDelta[]): PairedDelta[] {
  const testable = deltas.filter((delta) => delta.pValue !== null);
  const ordered = [...testable].sort((left, right) => left.pValue! - right.pValue!);
  const adjusted = new Map<string, number>();
  let running = 0;
  ordered.forEach((delta, index) => {
    const factor = ordered.length - index;
    running = Math.max(running, Math.min(1, delta.pValue! * factor));
    adjusted.set(delta.label, running);
  });

  return deltas.map((delta) => {
    const holm = adjusted.get(delta.label) ?? null;
    const excludesZero = delta.ci95 !== null && (delta.ci95[0] > 0 || delta.ci95[1] < 0);
    return {
      ...delta,
      holmAdjustedP: holm,
      significant: holm !== null && holm < 0.05 && excludesZero,
    };
  });
}
