/**
 * Concurrency, Uniqueness & Overlap Accounting (Phase 29 §1, §5).
 *
 * Implements López de Prado's concurrency and uniqueness weighting framework:
 * - Quantifies how many active forward labels overlap each 1-minute time bucket.
 * - Computes sample uniqueness weight as the mean of (1 / concurrency(t)) over the sample's lifespan.
 * - Computes the Overlap-Adjusted Sample Count (sum of uniqueness weights) to prevent overstating statistical power.
 */

export interface IntervalSample {
  readonly sampleId: string;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

export interface SampleUniqueness {
  readonly sampleId: string;
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
  readonly avgConcurrency: number;
  readonly uniquenessWeight: number; // 0 to 1
}

export interface OverlapSummary {
  readonly rawSampleCount: number;
  readonly overlapAdjustedSampleCount: number;
  readonly averageConcurrency: number;
  readonly medianConcurrency: number;
  readonly averageUniqueness: number;
}

/**
 * Computes sample uniqueness weights and concurrency statistics for a set of labeled intervals.
 */
export function computeConcurrencyAndUniqueness(
  samples: readonly IntervalSample[],
): { samplesWithUniqueness: SampleUniqueness[]; summary: OverlapSummary } {
  if (samples.length === 0) {
    return {
      samplesWithUniqueness: [],
      summary: {
        rawSampleCount: 0,
        overlapAdjustedSampleCount: 0,
        averageConcurrency: 0,
        medianConcurrency: 0,
        averageUniqueness: 0,
      },
    };
  }

  // 1. Build a minute-by-minute concurrency count map
  const concurrencyByMinute = new Map<number, number>();

  for (const sample of samples) {
    const startMs = sample.labelStartAt.getTime();
    const endMs = sample.labelEndAt.getTime();

    // Round to 1m buckets
    const startMin = Math.floor(startMs / 60_000);
    const endMinExclusive = Math.max(startMin + 1, Math.ceil(endMs / 60_000));

    for (let m = startMin; m < endMinExclusive; m += 1) {
      concurrencyByMinute.set(m, (concurrencyByMinute.get(m) ?? 0) + 1);
    }
  }

  // 2. Compute uniqueness weight for each sample
  const samplesWithUniqueness: SampleUniqueness[] = [];
  let totalUniqueness = 0;

  for (const sample of samples) {
    const startMs = sample.labelStartAt.getTime();
    const endMs = sample.labelEndAt.getTime();

    const startMin = Math.floor(startMs / 60_000);
    const endMinExclusive = Math.max(startMin + 1, Math.ceil(endMs / 60_000));

    let sampleConcurrencySum = 0;
    let sampleMinutesCount = 0;
    let sampleInvConcurrencySum = 0;

    for (let m = startMin; m < endMinExclusive; m += 1) {
      const c = concurrencyByMinute.get(m) ?? 1;
      sampleConcurrencySum += c;
      sampleInvConcurrencySum += 1.0 / c;
      sampleMinutesCount += 1;
    }

    const avgConcurrency = sampleMinutesCount > 0 ? sampleConcurrencySum / sampleMinutesCount : 1.0;
    const uniquenessWeight = sampleMinutesCount > 0 ? sampleInvConcurrencySum / sampleMinutesCount : 1.0;

    totalUniqueness += uniquenessWeight;

    samplesWithUniqueness.push({
      sampleId: sample.sampleId,
      labelStartAt: sample.labelStartAt,
      labelEndAt: sample.labelEndAt,
      avgConcurrency,
      uniquenessWeight,
    });
  }

  // Report concurrency across active time buckets, not the median of per-sample
  // averages (which is a different statistic).
  const concurrencyValues = Array.from(concurrencyByMinute.values()).sort((a, b) => a - b);
  const mid = Math.floor(concurrencyValues.length / 2);
  const medianConcurrency = concurrencyValues.length % 2 === 0
    ? (concurrencyValues[mid - 1]! + concurrencyValues[mid]!) / 2
    : concurrencyValues[mid]!;

  const averageConcurrency = concurrencyValues.reduce((a, b) => a + b, 0) / concurrencyValues.length;
  const averageUniqueness = totalUniqueness / samples.length;

  return {
    samplesWithUniqueness,
    summary: {
      rawSampleCount: samples.length,
      overlapAdjustedSampleCount: totalUniqueness,
      averageConcurrency,
      medianConcurrency,
      averageUniqueness,
    },
  };
}
