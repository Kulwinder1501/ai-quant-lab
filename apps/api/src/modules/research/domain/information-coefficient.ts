/**
 * Rank correlation between a feature and a forward return, with bootstrap uncertainty.
 *
 * The information coefficient is the microstructure programme's primary statistic, so the two
 * decisions embedded here matter more than the arithmetic.
 *
 * ## Rank correlation, not Pearson
 *
 * Order-flow features are heavy-tailed and occasionally absurd: one 50-level book update during a
 * liquidity vacuum produces an imbalance an order of magnitude past anything typical. Pearson
 * correlation would let that single observation set the reported edge. Spearman asks only whether
 * large feature values line up with large returns, which is also the only claim a threshold-based
 * trading rule ever acts on. Pearson is exported alongside it because the *gap* between the two is
 * itself diagnostic — a Spearman near zero with a large Pearson means one observation is carrying
 * the result.
 *
 * ## Ties are averaged, and that is not cosmetic
 *
 * Order-book features tie constantly: a quiet book yields identical imbalance values for many
 * consecutive frames, and a whole session can be one repeated number. Competition ranking would
 * impose a spurious ordering on those, manufacturing correlation out of arrival order. Averaged
 * ranks give tied observations the same rank, which is what makes a constant stretch contribute
 * nothing instead of contributing noise.
 *
 * A fully constant series has zero rank variance and therefore no defined correlation. That returns
 * `null`, never `0`. The distinction is the whole point: `0` asserts "measured, no relationship",
 * while `null` says "nothing was measurable here". Reporting an unmeasurable feature as 0 would let
 * a broken feature pipeline read as an honest negative result.
 */

/** Deterministic PRNG. Seeded so a bootstrap interval is reproducible across runs and machines. */
export function createSeededRandom(seed: number): () => number {
  // mulberry32. Chosen for being one line and having no state to get wrong; this is resampling,
  // not cryptography.
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

function isFinitePair(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right);
}

/** Ranks, ties averaged. Input order is preserved in the output. */
export function averagedRanks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((left, right) => left.value - right.value);

  const ranks = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1]!.value === indexed[position]!.value) end += 1;
    // Ranks are 1-based; the shared rank is the mean of the positions the tied block spans.
    const sharedRank = (position + end + 2) / 2;
    for (let cursor = position; cursor <= end; cursor += 1) {
      ranks[indexed[cursor]!.index] = sharedRank;
    }
    position = end + 1;
  }
  return ranks;
}

/** Pearson correlation, or null when either series has no variance. */
export function pearson(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;

  let count = 0;
  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!isFinitePair(left[index]!, right[index]!)) continue;
    count += 1;
    sumLeft += left[index]!;
    sumRight += right[index]!;
  }
  if (count < 2) return null;

  const meanLeft = sumLeft / count;
  const meanRight = sumRight / count;

  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!isFinitePair(left[index]!, right[index]!)) continue;
    const deltaLeft = left[index]! - meanLeft;
    const deltaRight = right[index]! - meanRight;
    covariance += deltaLeft * deltaRight;
    varianceLeft += deltaLeft * deltaLeft;
    varianceRight += deltaRight * deltaRight;
  }
  if (varianceLeft <= 0 || varianceRight <= 0) return null;

  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/** Spearman rank correlation, or null when either series is constant. */
export function spearman(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;

  // Drop non-finite pairs before ranking; ranking them would order NaN arbitrarily.
  const cleanLeft: number[] = [];
  const cleanRight: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (!isFinitePair(left[index]!, right[index]!)) continue;
    cleanLeft.push(left[index]!);
    cleanRight.push(right[index]!);
  }
  if (cleanLeft.length < 2) return null;

  return pearson(averagedRanks(cleanLeft), averagedRanks(cleanRight));
}

export interface InformationCoefficient {
  /** Spearman rank IC. Null when unmeasurable, which is not the same as zero. */
  readonly ic: number | null;
  /** Pearson, for comparison. A large gap versus `ic` means outliers are driving the result. */
  readonly pearsonIc: number | null;
  /** Pairs that survived the finite filter. */
  readonly sampleSize: number;
  /** Percentile bootstrap interval for `ic`, or null when it could not be formed. */
  readonly confidenceInterval: { readonly lower: number; readonly upper: number } | null;
  /** Two-sided, bootstrap-under-the-null p-value. Null when no stable bootstrap can be formed. */
  readonly pValue: number | null;
}

export interface InformationCoefficientOptions {
  readonly bootstrapSamples?: number;
  readonly seed?: number;
  /** Two-sided coverage, default 0.95. */
  readonly coverage?: number;
  /** Optional day-block identifiers (e.g. session dates) aligned with feature/forwardReturn to resample by trading-day blocks rather than IID pairs. */
  readonly dayKeys?: readonly (string | number)[];
}

/**
 * IC with a percentile bootstrap interval.
 *
 * When `dayKeys` is provided, resampling is performed at the day-block level to account for
 * within-session serial dependence and overlapping forward labels (Phase 29 requirement).
 * Otherwise, pairs are resampled together.
 */
export function informationCoefficient(
  feature: readonly number[],
  forwardReturn: readonly number[],
  options: InformationCoefficientOptions = {},
): InformationCoefficient {
  const bootstrapSamples = options.bootstrapSamples ?? 1_000;
  const coverage = options.coverage ?? 0.95;

  const cleanFeature: number[] = [];
  const cleanReturn: number[] = [];
  const cleanDayKeys: (string | number)[] = [];
  const hasDayKeys = Boolean(options.dayKeys && options.dayKeys.length > 0);

  const shared = Math.min(
    feature.length,
    forwardReturn.length,
    hasDayKeys ? options.dayKeys!.length : Number.POSITIVE_INFINITY,
  );

  for (let index = 0; index < shared; index += 1) {
    if (!isFinitePair(feature[index]!, forwardReturn[index]!)) continue;
    cleanFeature.push(feature[index]!);
    cleanReturn.push(forwardReturn[index]!);
    if (hasDayKeys) {
      cleanDayKeys.push(options.dayKeys![index]!);
    }
  }

  const ic = spearman(cleanFeature, cleanReturn);
  const pearsonIc = pearson(cleanFeature, cleanReturn);
  const sampleSize = cleanFeature.length;

  let confidenceInterval: { lower: number; upper: number } | null = null;
  let pValue: number | null = null;
  if (ic !== null && sampleSize >= 8 && bootstrapSamples > 0) {
    const random = createSeededRandom(options.seed ?? 1);
    const draws: number[] = [];

    if (hasDayKeys && cleanDayKeys.length > 0) {
      // Group indices by day
      const dayMap = new Map<string | number, number[]>();
      for (let index = 0; index < cleanDayKeys.length; index += 1) {
        const key = cleanDayKeys[index]!;
        let list = dayMap.get(key);
        if (!list) {
          list = [];
          dayMap.set(key, list);
        }
        list.push(index);
      }
      const uniqueDays = Array.from(dayMap.keys());

      if (uniqueDays.length >= 2) {
        // Rank once, then cluster-bootstrap rank-moment sufficient statistics.
        // Re-sorting tens of thousands of intraday rows for every bootstrap draw makes
        // the full pre-registered grid needlessly quadratic in practice.
        const rankedFeature = averagedRanks(cleanFeature);
        const rankedReturn = averagedRanks(cleanReturn);
        const momentsByDay = new Map<string | number, {
          n: number; sumX: number; sumY: number; sumXX: number; sumYY: number; sumXY: number;
        }>();
        for (const dayKey of uniqueDays) {
          const moments = { n: 0, sumX: 0, sumY: 0, sumXX: 0, sumYY: 0, sumXY: 0 };
          for (const index of dayMap.get(dayKey)!) {
            const x = rankedFeature[index]!;
            const y = rankedReturn[index]!;
            moments.n += 1;
            moments.sumX += x;
            moments.sumY += y;
            moments.sumXX += x * x;
            moments.sumYY += y * y;
            moments.sumXY += x * y;
          }
          momentsByDay.set(dayKey, moments);
        }
        for (let sample = 0; sample < bootstrapSamples; sample += 1) {
          let n = 0;
          let sumX = 0;
          let sumY = 0;
          let sumXX = 0;
          let sumYY = 0;
          let sumXY = 0;
          for (let dayIdx = 0; dayIdx < uniqueDays.length; dayIdx += 1) {
            const pick = Math.min(uniqueDays.length - 1, Math.floor(random() * uniqueDays.length));
            const moments = momentsByDay.get(uniqueDays[pick]!)!;
            n += moments.n;
            sumX += moments.sumX;
            sumY += moments.sumY;
            sumXX += moments.sumXX;
            sumYY += moments.sumYY;
            sumXY += moments.sumXY;
          }
          const covariance = sumXY - (sumX * sumY) / n;
          const varianceX = sumXX - (sumX * sumX) / n;
          const varianceY = sumYY - (sumY * sumY) / n;
          if (varianceX > 0 && varianceY > 0) draws.push(covariance / Math.sqrt(varianceX * varianceY));
        }
      }
    } else {
      const resampledFeature = new Array<number>(sampleSize);
      const resampledReturn = new Array<number>(sampleSize);

      for (let sample = 0; sample < bootstrapSamples; sample += 1) {
        for (let slot = 0; slot < sampleSize; slot += 1) {
          const pick = Math.min(sampleSize - 1, Math.floor(random() * sampleSize));
          resampledFeature[slot] = cleanFeature[pick]!;
          resampledReturn[slot] = cleanReturn[pick]!;
        }
        const drawn = spearman(resampledFeature, resampledReturn);
        if (drawn !== null) draws.push(drawn);
      }
    }

    if (draws.length >= 20) {
      draws.sort((left, right) => left - right);
      const tail = (1 - coverage) / 2;
      const lowerIndex = Math.max(0, Math.floor(tail * (draws.length - 1)));
      const upperIndex = Math.min(draws.length - 1, Math.ceil((1 - tail) * (draws.length - 1)));
      confidenceInterval = { lower: draws[lowerIndex]!, upper: draws[upperIndex]! };

      // Centre the bootstrap distribution at the null before measuring a two-sided tail.
      // This supplies callers with an actual resampling p-value for multiplicity control;
      // inferring a p-value from whether a percentile CI crosses zero is not valid.
      const observedMagnitude = Math.abs(ic);
      const extreme = draws.reduce(
        (count, draw) => count + (Math.abs(draw - ic) >= observedMagnitude ? 1 : 0),
        0,
      );
      pValue = (extreme + 1) / (draws.length + 1);
    }
  }

  return { ic, pearsonIc, sampleSize, confidenceInterval, pValue };
}
