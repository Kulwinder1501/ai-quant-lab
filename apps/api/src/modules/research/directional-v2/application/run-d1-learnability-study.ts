import type { DirectionalDataset, DirectionalSample } from "./generate-directional-dataset.js";
import type { SessionCandle } from "../domain/session-calendar.js";
import { extractMinimalFeaturesForSample, type FeatureVector } from "./feature-engine.js";
import { createPurgedWalkForwardSplits, fitFoldScaler, type CvSplit } from "./purged-walk-forward-cv.js";
import {
  MultinomialLogisticRegression,
  BinaryLogisticRegression,
  RidgeRegression,
  HuberRegression,
  QuantileRegression,
  TimeOfDayPrior,
  computeDecileMonotonicity,
  type LearnabilityEvaluation,
} from "./learnability-baselines.js";
import { informationCoefficient } from "../../domain/information-coefficient.js";
import { runFalsificationHarness } from "../../domain/falsification-harness.js";
import { applyHolm } from "../../../backtesting/domain/expectancy-statistics.js";

/**
 * Executes the D1 Simple Learnability Baseline Study (Phase 29 §4).
 *
 * Trains minimal baselines across all 6 label families and 3 horizons using purged walk-forward splits.
 * Enforces purged OOF evaluation, residual IC vs time-of-day prior, and day-block bootstrap uncertainty.
 */

export interface D1StudyOptions {
  readonly numFolds?: number;
  readonly minTrainSessions?: number;
  readonly seed?: number;
}

export interface HolmAdjustedVerdict {
  readonly target: string;
  readonly horizon: 15 | 30 | 60;
  readonly rawIc: number;
  readonly pValue: number;
  readonly adjustedPValue: number;
  readonly passed: boolean;
}

export interface D1StudyResult {
  readonly instrument: string;
  readonly totalEligibleSamples: number;
  readonly evaluations: readonly LearnabilityEvaluation[];
  readonly holmAdjustedVerdict: readonly HolmAdjustedVerdict[];
}

export function runD1LearnabilityStudy(
  dataset: DirectionalDataset,
  sessionCandles: readonly SessionCandle[],
  options: D1StudyOptions = {},
): D1StudyResult {
  const instrument = dataset.instrument;
  const numFolds = options.numFolds ?? 5;
  const minTrainSessions = options.minTrainSessions;
  const seed = options.seed ?? 42;

  // 1. Extract feature vectors for all samples
  const candleMapByDate = new Map<string, SessionCandle[]>();
  for (const c of sessionCandles) {
    const dStr = new Date(c.openTime.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    let list = candleMapByDate.get(dStr);
    if (!list) {
      list = [];
      candleMapByDate.set(dStr, list);
    }
    list.push(c);
  }

  const eligibleSamples: DirectionalSample[] = [];
  const featureVectors: number[][] = [];

  for (const sample of dataset.samples) {
    const candlesForSession = candleMapByDate.get(sample.sessionDate) ?? [];
    const fv = extractMinimalFeaturesForSample(sample, candlesForSession);
    if (fv.isEligible) {
      eligibleSamples.push(sample);
      featureVectors.push([...fv.features]);
    }
  }

  const evaluations: LearnabilityEvaluation[] = [];
  const horizons: (15 | 30 | 60)[] = [15, 30, 60];

  for (const horizon of horizons) {
    const splits = createPurgedWalkForwardSplits(eligibleSamples, horizon, { numFolds, minTrainSessions });
    if (splits.length === 0) continue;

    // --- Experiment 1: D0-A Adaptive Horizon (Multinomial Logistic) ------------
    {
      const oofScores: number[] = [];
      const actualReturns: number[] = [];
      const dayKeys: string[] = [];
      const minuteOfDays: number[] = [];
      const oofSampleIndices: number[] = [];

      for (const split of splits) {
        const trainXRaw = split.trainIndices.map((i) => featureVectors[i]!);
        const validXRaw = split.validIndices.map((i) => featureVectors[i]!);

        const scaler = fitFoldScaler(trainXRaw);
        const trainX = trainXRaw.map((f) => scaler.transform(f));
        const validX = validXRaw.map((f) => scaler.transform(f));

        const trainY = split.trainIndices.map((i) => {
          const l = eligibleSamples[i]![`adaptive${horizon}`]!.label;
          return l === "UP" ? 0 : l === "NEUTRAL" ? 1 : 2;
        });

        const model = new MultinomialLogisticRegression();
        model.fit(trainX, trainY, 3);

        for (let v = 0; v < validX.length; v += 1) {
          const sample = eligibleSamples[split.validIndices[v]!]!;
          const probs = model.predictProbas(validX[v]!);
          const score = (probs[0] ?? 0) - (probs[2] ?? 0); // pUp - pDown
          oofScores.push(score);
          actualReturns.push(sample[`adaptive${horizon}`]!.futureReturnBps);
          dayKeys.push(sample.sessionDate);
          minuteOfDays.push(sample.minuteOfDay);
          oofSampleIndices.push(split.validIndices[v]!);
        }
      }

      const evalResult = evaluateOofPredictions(
        "D0-A Adaptive",
        horizon,
        "MultinomialLogistic",
        oofScores,
        actualReturns,
        dayKeys,
        minuteOfDays,
        oofSampleIndices,
        splits,
        eligibleSamples,
        seed,
      );
      evaluations.push(evalResult);
    }

    // --- Experiment 2: D0-B Triple Barrier (Multinomial Logistic) ---------------
    {
      const targetSplits = createPurgedWalkForwardSplits(
        eligibleSamples,
        horizon,
        { numFolds, minTrainSessions },
        (sample) => sample[`tb${horizon}`],
      );
      const oofScores: number[] = [];
      const actualReturns: number[] = [];
      const dayKeys: string[] = [];
      const minuteOfDays: number[] = [];
      const oofSampleIndices: number[] = [];

      for (const split of targetSplits) {
        // Exclude ambiguous from training
        const cleanTrainIndices = split.trainIndices.filter(
          (i) => !eligibleSamples[i]![`tb${horizon}`]!.isAmbiguous,
        );
        const cleanValidIndices = split.validIndices.filter(
          (i) => !eligibleSamples[i]![`tb${horizon}`]!.isAmbiguous,
        );

        const trainXRaw = cleanTrainIndices.map((i) => featureVectors[i]!);
        const validXRaw = cleanValidIndices.map((i) => featureVectors[i]!);

        const scaler = fitFoldScaler(trainXRaw);
        const trainX = trainXRaw.map((f) => scaler.transform(f));
        const validX = validXRaw.map((f) => scaler.transform(f));

        const trainY = cleanTrainIndices.map((i) => {
          const bo = eligibleSamples[i]![`tb${horizon}`]!.barrierOutcome;
          return bo === "UPPER" ? 0 : bo === "TIME" ? 1 : 2;
        });

        const model = new MultinomialLogisticRegression();
        model.fit(trainX, trainY, 3);

        for (let v = 0; v < validX.length; v += 1) {
          const sample = eligibleSamples[cleanValidIndices[v]!]!;
          const probs = model.predictProbas(validX[v]!);
          const score = (probs[0] ?? 0) - (probs[2] ?? 0); // pUpper - pLower
          oofScores.push(score);
          actualReturns.push(sample[`adaptive${horizon}`]!.futureReturnBps);
          dayKeys.push(sample.sessionDate);
          minuteOfDays.push(sample.minuteOfDay);
          oofSampleIndices.push(cleanValidIndices[v]!);
        }
      }

      const evalResult = evaluateOofPredictions(
        "D0-B Triple Barrier",
        horizon,
        "MultinomialLogistic",
        oofScores,
        actualReturns,
        dayKeys,
        minuteOfDays,
        oofSampleIndices,
        targetSplits,
        eligibleSamples,
        seed,
      );
      evaluations.push(evalResult);
    }

    // --- Experiment 3: D0-C Signed Path Efficiency (Ridge Regression) -----------
    {
      const oofScores: number[] = [];
      const actualReturns: number[] = [];
      const dayKeys: string[] = [];
      const minuteOfDays: number[] = [];
      const oofSampleIndices: number[] = [];

      for (const split of splits) {
        const trainXRaw = split.trainIndices.map((i) => featureVectors[i]!);
        const validXRaw = split.validIndices.map((i) => featureVectors[i]!);

        const scaler = fitFoldScaler(trainXRaw);
        const trainX = trainXRaw.map((f) => scaler.transform(f));
        const validX = validXRaw.map((f) => scaler.transform(f));

        const trainY = split.trainIndices.map((i) => eligibleSamples[i]![`pathEff${horizon}`]!.signedPathEfficiency);

        const model = new RidgeRegression();
        model.fit(trainX, trainY);

        for (let v = 0; v < validX.length; v += 1) {
          const sample = eligibleSamples[split.validIndices[v]!]!;
          const score = model.predict(validX[v]!);
          oofScores.push(score);
          actualReturns.push(sample[`adaptive${horizon}`]!.futureReturnBps);
          dayKeys.push(sample.sessionDate);
          minuteOfDays.push(sample.minuteOfDay);
          oofSampleIndices.push(split.validIndices[v]!);
        }
      }

      const evalResult = evaluateOofPredictions(
        "D0-C Path Efficiency",
        horizon,
        "RidgeRegression",
        oofScores,
        actualReturns,
        dayKeys,
        minuteOfDays,
        oofSampleIndices,
        splits,
        eligibleSamples,
        seed,
      );
      evaluations.push(evalResult);
    }

    // --- Experiment 4: D0-D1 Raw Return (Ridge Regression) ----------------------
    {
      const oofScores: number[] = [];
      const actualReturns: number[] = [];
      const dayKeys: string[] = [];
      const minuteOfDays: number[] = [];
      const oofSampleIndices: number[] = [];

      for (const split of splits) {
        const trainXRaw = split.trainIndices.map((i) => featureVectors[i]!);
        const validXRaw = split.validIndices.map((i) => featureVectors[i]!);

        const scaler = fitFoldScaler(trainXRaw);
        const trainX = trainXRaw.map((f) => scaler.transform(f));
        const validX = validXRaw.map((f) => scaler.transform(f));

        const trainY = split.trainIndices.map((i) => eligibleSamples[i]![`continuous${horizon}`]!.rawReturnBps);

        const model = new RidgeRegression();
        model.fit(trainX, trainY);

        for (let v = 0; v < validX.length; v += 1) {
          const sample = eligibleSamples[split.validIndices[v]!]!;
          const score = model.predict(validX[v]!);
          oofScores.push(score);
          actualReturns.push(sample[`adaptive${horizon}`]!.futureReturnBps);
          dayKeys.push(sample.sessionDate);
          minuteOfDays.push(sample.minuteOfDay);
          oofSampleIndices.push(split.validIndices[v]!);
        }
      }

      const evalResult = evaluateOofPredictions(
        "D0-D1 Raw Return",
        horizon,
        "RidgeRegression",
        oofScores,
        actualReturns,
        dayKeys,
        minuteOfDays,
        oofSampleIndices,
        splits,
        eligibleSamples,
        seed,
      );
      evaluations.push(evalResult);
    }

    // --- Experiment 5: D0-E Move-then-Side (Two-Stage Decomposition) ------------
    evaluations.push(runRegressionOof({
      targetName: "D0-D1 Raw Return (Huber)",
      modelType: "HuberRegression",
      horizon,
      splits,
      eligibleSamples,
      featureVectors,
      seed,
      target: (sample) => sample[`continuous${horizon}`]!.rawReturnBps,
      modelFactory: () => new HuberRegression(),
    }));

    evaluations.push(runRegressionOof({
      targetName: "D0-D2 Vol-Normalized",
      modelType: "RidgeRegression",
      horizon,
      splits,
      eligibleSamples,
      featureVectors,
      seed,
      target: (sample) => sample[`continuous${horizon}`]!.volNormalizedReturn,
      modelFactory: () => new RidgeRegression(),
    }));

    evaluations.push(runRegressionOof({
      targetName: "D0-D Quantile Median",
      modelType: "QuantileRegression(q=0.5)",
      horizon,
      splits,
      eligibleSamples,
      featureVectors,
      seed,
      target: (sample) => sample[`continuous${horizon}`]!.rawReturnBps,
      modelFactory: () => new QuantileRegression(),
    }));

    // --- Experiment 8: D0-E Move-then-Side (Two-Stage Decomposition) ------------
    {
      const oofScores: number[] = [];
      const actualReturns: number[] = [];
      const dayKeys: string[] = [];
      const minuteOfDays: number[] = [];
      const oofSampleIndices: number[] = [];

      for (const split of splits) {
        const trainXRaw = split.trainIndices.map((i) => featureVectors[i]!);
        const validXRaw = split.validIndices.map((i) => featureVectors[i]!);

        const scaler = fitFoldScaler(trainXRaw);
        const trainX = trainXRaw.map((f) => scaler.transform(f));
        const validX = validXRaw.map((f) => scaler.transform(f));

        // Stage 1: MOVE label (all train rows)
        const trainYMove = split.trainIndices.map((i) => eligibleSamples[i]![`moveSide${horizon}`]!.moveLabel);
        const modelMove = new BinaryLogisticRegression();
        modelMove.fit(trainX, trainYMove);

        // Stage 2: SIDE label (strictly train rows where MOVE === 1)
        const sideTrainX: number[][] = [];
        const sideTrainY: number[] = [];
        for (let t = 0; t < split.trainIndices.length; t += 1) {
          const origIdx = split.trainIndices[t]!;
          const ms = eligibleSamples[origIdx]![`moveSide${horizon}`]!;
          if (ms.moveLabel === 1 && ms.sideLabel !== null) {
            sideTrainX.push(trainX[t]!);
            sideTrainY.push(ms.sideLabel === "UP" ? 1 : 0);
          }
        }

        const modelSide = new BinaryLogisticRegression();
        if (sideTrainX.length > 0) {
          modelSide.fit(sideTrainX, sideTrainY);
        }

        // Validation: Score ALL validation rows and reconstruct unconditional probabilities
        for (let v = 0; v < validX.length; v += 1) {
          const sample = eligibleSamples[split.validIndices[v]!]!;
          const pMove = modelMove.predictProba(validX[v]!);
          const pUpGivenMove = modelSide.predictProba(validX[v]!);

          const pUp = pMove * pUpGivenMove;
          const pDown = pMove * (1 - pUpGivenMove);
          const score = pUp - pDown;

          oofScores.push(score);
          actualReturns.push(sample[`adaptive${horizon}`]!.futureReturnBps);
          dayKeys.push(sample.sessionDate);
          minuteOfDays.push(sample.minuteOfDay);
          oofSampleIndices.push(split.validIndices[v]!);
        }
      }

      const evalResult = evaluateOofPredictions(
        "D0-E Move-then-Side",
        horizon,
        "TwoStageLogistic",
        oofScores,
        actualReturns,
        dayKeys,
        minuteOfDays,
        oofSampleIndices,
        splits,
        eligibleSamples,
        seed,
      );
      evaluations.push(evalResult);
    }
  }

  // Multiplicity Control: Holm-Bonferroni across the pre-declared grid
  const pairedDeltas = evaluations.map((e) => {
    // The protocol's learnability question is incremental skill after removing the
    // train-fitted time-of-day prior, so multiplicity is applied to residual IC.
    const ic = e.oofResidualIc.ic ?? 0;
    const ci = e.oofResidualIc.confidenceInterval;
    const ciTuple: [number, number] | null = ci ? [ci.lower, ci.upper] : null;
    return {
      label: `${e.targetName}--${e.horizonMinutes}m`,
      pairedDays: new Set(eligibleSamples.map((sample) => sample.sessionDate)).size,
      meanDelta: ic,
      standardError: ci ? (ci.upper - ci.lower) / (2 * 1.96) : null,
      ci95: ciTuple,
      pValue: e.oofResidualIc.pValue,
    };
  });

  const holm = applyHolm(pairedDeltas);
  const holmAdjustedVerdict = holm.map((h, idx) => ({
    target: evaluations[idx]!.targetName,
    horizon: evaluations[idx]!.horizonMinutes,
    rawIc: h.meanDelta ?? 0,
    pValue: h.pValue ?? 1.0,
    adjustedPValue: h.holmAdjustedP ?? 1.0,
    passed: Boolean(h.significant && (h.meanDelta ?? 0) > 0),
  }));

  const evaluationsWithGates = evaluations.map((evaluation, index): LearnabilityEvaluation => ({
    ...evaluation,
    verdict: holmAdjustedVerdict[index]?.passed === true
      && evaluation.falsificationSuite?.verdict === "PASS"
      ? evaluation.verdict
      : "REJECT",
  }));

  return {
    instrument,
    totalEligibleSamples: eligibleSamples.length,
    evaluations: evaluationsWithGates,
    holmAdjustedVerdict,
  };
}

interface RegressionLike {
  fit(X: readonly (readonly number[])[], y: readonly number[]): void;
  predict(x: readonly number[]): number;
}

function runRegressionOof(input: {
  readonly targetName: string;
  readonly modelType: string;
  readonly horizon: 15 | 30 | 60;
  readonly splits: readonly CvSplit[];
  readonly eligibleSamples: readonly DirectionalSample[];
  readonly featureVectors: readonly (readonly number[])[];
  readonly seed: number;
  readonly target: (sample: DirectionalSample) => number;
  readonly modelFactory: () => RegressionLike;
}): LearnabilityEvaluation {
  const oofScores: number[] = [];
  const actualReturns: number[] = [];
  const dayKeys: string[] = [];
  const minuteOfDays: number[] = [];
  const oofSampleIndices: number[] = [];

  for (const split of input.splits) {
    const trainXRaw = split.trainIndices.map((index) => input.featureVectors[index]!);
    const validXRaw = split.validIndices.map((index) => input.featureVectors[index]!);
    const scaler = fitFoldScaler(trainXRaw);
    const trainX = trainXRaw.map((features) => scaler.transform(features));
    const validX = validXRaw.map((features) => scaler.transform(features));
    const trainY = split.trainIndices.map((index) => input.target(input.eligibleSamples[index]!));
    const model = input.modelFactory();
    model.fit(trainX, trainY);

    for (let position = 0; position < validX.length; position += 1) {
      const sampleIndex = split.validIndices[position]!;
      const sample = input.eligibleSamples[sampleIndex]!;
      oofScores.push(model.predict(validX[position]!));
      actualReturns.push(sample[`adaptive${input.horizon}`]!.futureReturnBps);
      dayKeys.push(sample.sessionDate);
      minuteOfDays.push(sample.minuteOfDay);
      oofSampleIndices.push(sampleIndex);
    }
  }

  return evaluateOofPredictions(
    input.targetName,
    input.horizon,
    input.modelType,
    oofScores,
    actualReturns,
    dayKeys,
    minuteOfDays,
    oofSampleIndices,
    input.splits,
    input.eligibleSamples,
    input.seed,
  );
}

function evaluateOofPredictions(
  targetName: string,
  horizonMinutes: 15 | 30 | 60,
  modelType: string,
  oofScores: readonly number[],
  actualReturns: readonly number[],
  dayKeys: readonly string[],
  minuteOfDays: readonly number[],
  oofSampleIndices: readonly number[],
  splits: readonly CvSplit[],
  eligibleSamples: readonly DirectionalSample[],
  seed: number,
): LearnabilityEvaluation {
  // 1. Spearman IC with day-block bootstrap
  const oofSpearmanIc = informationCoefficient(oofScores, actualReturns, {
    seed,
    bootstrapSamples: 500,
    dayKeys,
  });

  // 2. Residual IC vs Time-of-Day Baseline (B2)
  // Fit B2 prior across train folds and compute OOF residual return
  const expectedReturnBySampleIndex = new Map<number, number>();
  for (let s = 0; s < splits.length; s += 1) {
    const split = splits[s]!;
    const trainMinOfDays = split.trainIndices.map((i) => eligibleSamples[i]!.minuteOfDay);
    const trainReturns = split.trainIndices.map((i) => eligibleSamples[i]![`adaptive${horizonMinutes}`]!.futureReturnBps);

    const b2 = new TimeOfDayPrior();
    b2.fit(trainMinOfDays, trainReturns);

    for (const vIdx of split.validIndices) {
      const sample = eligibleSamples[vIdx]!;
      const expectedRet = b2.predict(sample.minuteOfDay);
      const actualRet = sample[`adaptive${horizonMinutes}`]!.futureReturnBps;
      expectedReturnBySampleIndex.set(vIdx, expectedRet);
    }
  }

  const residualReturns = oofSampleIndices.map((sampleIndex, position) => (
    actualReturns[position]! - (expectedReturnBySampleIndex.get(sampleIndex) ?? 0)
  ));

  const oofResidualIc = informationCoefficient(oofScores, residualReturns, {
    seed,
    bootstrapSamples: 500,
    dayKeys,
  });

  // 3. Decile Monotonicity
  const deciles = computeDecileMonotonicity(oofScores, actualReturns, 10);

  // 4. Placebos / Falsification Harness Pass
  const falsificationSuite = runFalsificationHarness(
    oofSampleIndices.map((sampleIndex, position) => ({
      at: eligibleSamples[sampleIndex]!.decisionAt,
      featureAsOf: eligibleSamples[sampleIndex]!.dataThrough,
      featureValue: oofScores[position]!,
      forwardReturn: actualReturns[position]!,
      labelEndAt: eligibleSamples[sampleIndex]![`adaptive${horizonMinutes}`]!.labelEndAt,
    })),
    {
      bootstrapSamples: 200,
      seed,
      // The frozen seven-feature baseline deliberately contains trailing price returns. Its score
      // may therefore correlate with realised history without looking ahead; lag IC is diagnostic.
      negativeLagMode: "diagnostic",
    },
  );

  // 5. Verdict determination
  const icVal = oofSpearmanIc.ic ?? 0;
  const resIcVal = oofResidualIc.ic ?? 0;
  const ci = oofSpearmanIc.confidenceInterval;

  let verdict: "PASS" | "INTERESTING" | "WEAK" | "REJECT" = "REJECT";
  if (falsificationSuite.verdict !== "PASS") {
    verdict = "REJECT";
  } else if (icVal > 0.02 && resIcVal > 0.01 && ci && ci.lower > 0) {
    verdict = "PASS";
  } else if (icVal > 0.01 && resIcVal > 0) {
    verdict = "INTERESTING";
  } else if (icVal > 0) {
    verdict = "WEAK";
  }

  return {
    targetName,
    horizonMinutes,
    modelType,
    sampleCount: oofScores.length,
    oofSpearmanIc,
    oofResidualIc,
    deciles,
    falsificationSuite,
    verdict,
  };
}
