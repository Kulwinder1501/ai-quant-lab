import type { DirectionalSample } from "./generate-directional-dataset.js";

/**
 * Purged Walk-Forward Cross-Validation Engine (Phase 29 §4, §5).
 *
 * Enforces strict financial CV hygiene:
 * - Purging: Strictly removes any training observation whose label interval `[labelStartAt, labelEndAt]`
 *   overlaps the validation evaluation interval.
 * - Embargo: Configurable buffer to prevent post-validation serial dependence.
 * - Fold-Local Preprocessing: Scalers and imputers are fitted ONLY on the training fold.
 */

export interface CvSplit {
  readonly foldIndex: number;
  readonly trainIndices: readonly number[];
  readonly validIndices: readonly number[];
  readonly trainSessions: readonly string[];
  readonly validSessions: readonly string[];
}

export interface FoldScaler {
  readonly means: readonly number[];
  readonly stds: readonly number[];
  transform(features: readonly number[]): number[];
}

export function fitFoldScaler(trainFeatureMatrix: readonly (readonly number[])[]): FoldScaler {
  if (trainFeatureMatrix.length === 0) {
    return {
      means: [],
      stds: [],
      transform: (f) => [...f],
    };
  }

  const numFeatures = trainFeatureMatrix[0]!.length;
  const means = new Array<number>(numFeatures).fill(0);
  const stds = new Array<number>(numFeatures).fill(1);

  for (let j = 0; j < numFeatures; j += 1) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < trainFeatureMatrix.length; i += 1) {
      const v = trainFeatureMatrix[i]![j]!;
      if (Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
    const mean = count > 0 ? sum / count : 0;
    means[j] = mean;

    let varSum = 0;
    for (let i = 0; i < trainFeatureMatrix.length; i += 1) {
      const v = trainFeatureMatrix[i]![j]!;
      if (Number.isFinite(v)) {
        const delta = v - mean;
        varSum += delta * delta;
      }
    }
    const variance = count > 1 ? varSum / (count - 1) : 1;
    stds[j] = variance > 1e-8 ? Math.sqrt(variance) : 1.0;
  }

  return {
    means,
    stds,
    transform(features: readonly number[]): number[] {
      return features.map((v, idx) => {
        if (!Number.isFinite(v)) return 0; // mean impute
        const mean = means[idx] ?? 0;
        const std = stds[idx] ?? 1;
        return (v - mean) / std;
      });
    },
  };
}

export interface WalkForwardCvOptions {
  readonly numFolds?: number; // default 5
  readonly embargoMinutes?: number; // default 30
  readonly minTrainSessions?: number; // default 50
}

export interface LabelInterval {
  readonly labelStartAt: Date;
  readonly labelEndAt: Date;
}

/**
 * Creates purged walk-forward cross-validation splits for a dataset.
 */
export function createPurgedWalkForwardSplits(
  samples: readonly DirectionalSample[],
  horizon: 15 | 30 | 60,
  options: WalkForwardCvOptions = {},
  intervalSelector?: (sample: DirectionalSample) => LabelInterval | undefined,
): CvSplit[] {
  const numFolds = options.numFolds ?? 5;
  const embargoMs = (options.embargoMinutes ?? 30) * 60_000;

  // Extract unique session dates in chronological order
  const sessionDates = Array.from(new Set(samples.map((s) => s.sessionDate))).sort();
  if (sessionDates.length < (numFolds + 1)) {
    return [];
  }

  const minTrainSessions = options.minTrainSessions ?? Math.max(2, Math.floor(sessionDates.length * 0.4));
  const remainingSessions = sessionDates.length - minTrainSessions;
  if (remainingSessions < numFolds) {
    // If not enough sessions to split into requested numFolds, adjust
    return [];
  }
  const valSize = Math.max(1, Math.floor(remainingSessions / numFolds));

  const splits: CvSplit[] = [];
  const labelKey = `adaptive${horizon}` as const;
  const getInterval = intervalSelector ?? ((sample: DirectionalSample) => sample[labelKey]);

  for (let fold = 0; fold < numFolds; fold += 1) {
    const valStartIdx = minTrainSessions + fold * valSize;
    const valEndIdx = fold === numFolds - 1 ? sessionDates.length : valStartIdx + valSize;

    const trainSessions = sessionDates.slice(0, valStartIdx);
    const validSessions = sessionDates.slice(valStartIdx, valEndIdx);

    const trainSessionSet = new Set(trainSessions);
    const validSessionSet = new Set(validSessions);

    // Initial train / valid partition
    const rawTrainIndices: number[] = [];
    const validIndices: number[] = [];

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]!;
      if (!getInterval(sample)) continue; // only samples with a valid target-specific outcome

      if (trainSessionSet.has(sample.sessionDate)) {
        rawTrainIndices.push(i);
      } else if (validSessionSet.has(sample.sessionDate)) {
        validIndices.push(i);
      }
    }

    if (validIndices.length === 0) continue;

    // Identify validation time bounds
    let valMinStartMs = Number.POSITIVE_INFINITY;
    let valMaxEndMs = Number.NEGATIVE_INFINITY;

    for (const vIdx of validIndices) {
      const sample = samples[vIdx]!;
      const outcome = getInterval(sample)!;
      const sMs = outcome.labelStartAt.getTime();
      const eMs = outcome.labelEndAt.getTime();
      if (sMs < valMinStartMs) valMinStartMs = sMs;
      if (eMs > valMaxEndMs) valMaxEndMs = eMs;
    }

    // Apply Purging & Embargo to train indices. In strict walk-forward CV all train
    // observations precede validation, so the relevant embargo is the buffer immediately
    // before validation begins (a post-validation embargo could never remove a train row).
    const purgedTrainIndices: number[] = [];

    for (const tIdx of rawTrainIndices) {
      const sample = samples[tIdx]!;
      const outcome = getInterval(sample)!;
      const tStartMs = outcome.labelStartAt.getTime();
      const tEndMs = outcome.labelEndAt.getTime();

      // Check overlap with validation span
      const overlapsVal = tStartMs <= valMaxEndMs && tEndMs >= valMinStartMs;
      // Check embargo
      const inEmbargo = tEndMs < valMinStartMs && tEndMs >= (valMinStartMs - embargoMs);

      if (!overlapsVal && !inEmbargo) {
        purgedTrainIndices.push(tIdx);
      }
    }

    splits.push({
      foldIndex: fold,
      trainIndices: purgedTrainIndices,
      validIndices,
      trainSessions,
      validSessions,
    });
  }

  return splits;
}
