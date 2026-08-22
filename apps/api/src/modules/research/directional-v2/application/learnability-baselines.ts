import { informationCoefficient, type InformationCoefficient } from "../../domain/information-coefficient.js";
import type { FalsificationReport } from "../../domain/falsification-harness.js";

/**
 * Learnability Baseline Models & Diagnostics for Directional Intelligence V2 (Phase 29 §4, §5).
 *
 * Implements:
 * - Multinomial Logistic Regression (L2 Regularized)
 * - Binary Logistic Regression (L2 Regularized)
 * - Ridge / Huber Linear Regression
 * - Time-of-Day Conditional Prior (Baseline B2)
 * - Decile Monotonicity Diagnostic
 * - Residual IC against B2 Prior
 * - Day-Block Bootstrap Confidence Intervals
 * - Placebo & Falsification Harness Pass
 */

// --- Matrix Utilities (Self-Contained) --------------------------------------

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function sigmoid(z: number): number {
  if (z > 30) return 1.0;
  if (z < -30) return 0.0;
  return 1.0 / (1.0 + Math.exp(-z));
}

function softmax(scores: readonly number[]): number[] {
  let maxScore = Number.NEGATIVE_INFINITY;
  for (const s of scores) if (s > maxScore) maxScore = s;
  const exps = scores.map((s) => Math.exp(s - maxScore));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => (sumExp > 0 ? e / sumExp : 1 / scores.length));
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let j = column; j <= n; j += 1) augmented[column]![j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let j = column; j <= n; j += 1) augmented[row]![j] -= factor * augmented[column]![j]!;
    }
  }
  return augmented.map((row) => row[n]!);
}

// --- Binary Logistic Regression ---------------------------------------------

export class BinaryLogisticRegression {
  private weights: number[] = [];
  private bias = 0;

  fit(
    X: readonly (readonly number[])[],
    y: readonly number[], // 0 or 1
    weights?: readonly number[],
    lambda = 1e-3,
    learningRate = 0.05,
    maxEpochs = 100,
  ): void {
    if (X.length === 0 || X[0]!.length === 0) return;
    const numFeatures = X[0]!.length;
    this.weights = new Array<number>(numFeatures).fill(0);
    this.bias = 0;

    const n = X.length;
    for (let epoch = 0; epoch < maxEpochs; epoch += 1) {
      const gradW = new Array<number>(numFeatures).fill(0);
      let gradB = 0;

      for (let i = 0; i < n; i += 1) {
        const x_i = X[i]!;
        const y_i = y[i]!;
        const sampleWeight = weights ? weights[i]! : 1.0;

        const pred = sigmoid(dot(this.weights, x_i) + this.bias);
        const err = (pred - y_i) * sampleWeight;

        for (let j = 0; j < numFeatures; j += 1) {
          gradW[j] += err * x_i[j]!;
        }
        gradB += err;
      }

      // Update with L2 regularization
      for (let j = 0; j < numFeatures; j += 1) {
        this.weights[j] -= learningRate * (gradW[j]! / n + lambda * this.weights[j]!);
      }
      this.bias -= learningRate * (gradB / n);
    }
  }

  predictProba(x: readonly number[]): number {
    return sigmoid(dot(this.weights, x) + this.bias);
  }
}

// --- Multinomial Logistic Regression ----------------------------------------

export class MultinomialLogisticRegression {
  private classWeights: number[][] = []; // [numClasses][numFeatures]
  private biases: number[] = [];
  private numClasses = 3;

  fit(
    X: readonly (readonly number[])[],
    y: readonly number[], // 0 = UP, 1 = NEUTRAL, 2 = DOWN
    numClasses = 3,
    weights?: readonly number[],
    lambda = 1e-3,
    learningRate = 0.05,
    maxEpochs = 100,
  ): void {
    if (X.length === 0 || X[0]!.length === 0) return;
    this.numClasses = numClasses;
    const numFeatures = X[0]!.length;

    this.classWeights = Array.from({ length: numClasses }, () => new Array<number>(numFeatures).fill(0));
    this.biases = new Array<number>(numClasses).fill(0);

    const n = X.length;
    for (let epoch = 0; epoch < maxEpochs; epoch += 1) {
      const gradW = Array.from({ length: numClasses }, () => new Array<number>(numFeatures).fill(0));
      const gradB = new Array<number>(numClasses).fill(0);

      for (let i = 0; i < n; i += 1) {
        const x_i = X[i]!;
        const y_i = y[i]!;
        const sampleWeight = weights ? weights[i]! : 1.0;

        const scores = this.classWeights.map((w, c) => dot(w, x_i) + this.biases[c]!);
        const probs = softmax(scores);

        for (let c = 0; c < numClasses; c += 1) {
          const target = y_i === c ? 1.0 : 0.0;
          const err = (probs[c]! - target) * sampleWeight;
          for (let j = 0; j < numFeatures; j += 1) {
            gradW[c]![j] += err * x_i[j]!;
          }
          gradB[c] += err;
        }
      }

      for (let c = 0; c < numClasses; c += 1) {
        for (let j = 0; j < numFeatures; j += 1) {
          this.classWeights[c]![j] -= learningRate * (gradW[c]![j]! / n + lambda * this.classWeights[c]![j]!);
        }
        this.biases[c] -= learningRate * (gradB[c]! / n);
      }
    }
  }

  predictProbas(x: readonly number[]): number[] {
    const scores = this.classWeights.map((w, c) => dot(w, x) + this.biases[c]!);
    return softmax(scores);
  }
}

// --- Ridge Regression (L2 Regularized Linear Regression) ---------------------

export class RidgeRegression {
  private weights: number[] = [];
  private bias = 0;

  fit(
    X: readonly (readonly number[])[],
    y: readonly number[],
    weights?: readonly number[],
    lambda = 1.0,
    _learningRate = 0.05,
    _maxEpochs = 200,
  ): void {
    if (X.length === 0 || X[0]!.length === 0) return;
    const numFeatures = X[0]!.length;
    const dimension = numFeatures + 1;
    const normal = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0));
    const rhs = new Array<number>(dimension).fill(0);
    for (let index = 0; index < X.length; index += 1) {
      const row = [1, ...X[index]!];
      const sampleWeight = weights?.[index] ?? 1;
      for (let left = 0; left < dimension; left += 1) {
        rhs[left] += sampleWeight * row[left]! * y[index]!;
        for (let right = 0; right < dimension; right += 1) {
          normal[left]![right] += sampleWeight * row[left]! * row[right]!;
        }
      }
    }
    for (let index = 1; index < dimension; index += 1) normal[index]![index] += lambda;
    const solution = solveLinearSystem(normal, rhs);
    this.bias = solution?.[0] ?? 0;
    this.weights = solution?.slice(1) ?? new Array<number>(numFeatures).fill(0);
  }

  predict(x: readonly number[]): number {
    return dot(this.weights, x) + this.bias;
  }
}

// --- Robust Huber Regression -------------------------------------------------

export class HuberRegression {
  private weights: number[] = [];
  private bias = 0;
  private targetMean = 0;
  private targetStd = 1;

  fit(
    X: readonly (readonly number[])[],
    y: readonly number[],
    delta = 1.35,
    lambda = 1.0,
    learningRate = 0.02,
    maxEpochs = 100,
  ): void {
    if (X.length === 0 || X[0]!.length === 0) return;
    const numFeatures = X[0]!.length;
    this.targetMean = y.reduce((sum, value) => sum + value, 0) / Math.max(1, y.length);
    const variance = y.length > 1
      ? y.reduce((sum, value) => sum + (value - this.targetMean) ** 2, 0) / (y.length - 1)
      : 1;
    this.targetStd = variance > 1e-8 ? Math.sqrt(variance) : 1;
    const scaledY = y.map((value) => (value - this.targetMean) / this.targetStd);
    this.weights = new Array<number>(numFeatures).fill(0);
    this.bias = 0;

    for (let epoch = 0; epoch < maxEpochs; epoch += 1) {
      const gradW = new Array<number>(numFeatures).fill(0);
      let gradB = 0;
      for (let i = 0; i < X.length; i += 1) {
        const residual = dot(this.weights, X[i]!) + this.bias - scaledY[i]!;
        const gradient = Math.abs(residual) <= delta ? residual : delta * Math.sign(residual);
        for (let j = 0; j < numFeatures; j += 1) gradW[j] += gradient * X[i]![j]!;
        gradB += gradient;
      }
      for (let j = 0; j < numFeatures; j += 1) {
        this.weights[j] -= learningRate * (gradW[j]! / X.length + lambda * this.weights[j]!);
      }
      this.bias -= learningRate * gradB / X.length;
    }
  }

  predict(x: readonly number[]): number {
    return (dot(this.weights, x) + this.bias) * this.targetStd + this.targetMean;
  }
}

// --- Linear Quantile Regression ---------------------------------------------

export class QuantileRegression {
  private weights: number[] = [];
  private bias = 0;
  private targetMean = 0;
  private targetStd = 1;

  fit(
    X: readonly (readonly number[])[],
    y: readonly number[],
    quantile = 0.5,
    lambda = 1e-3,
    learningRate = 0.01,
    maxEpochs = 150,
  ): void {
    if (!(quantile > 0 && quantile < 1)) throw new Error("quantile must be strictly between 0 and 1.");
    if (X.length === 0 || X[0]!.length === 0) return;
    const numFeatures = X[0]!.length;
    this.targetMean = y.reduce((sum, value) => sum + value, 0) / Math.max(1, y.length);
    const variance = y.length > 1
      ? y.reduce((sum, value) => sum + (value - this.targetMean) ** 2, 0) / (y.length - 1)
      : 1;
    this.targetStd = variance > 1e-8 ? Math.sqrt(variance) : 1;
    const scaledY = y.map((value) => (value - this.targetMean) / this.targetStd);
    this.weights = new Array<number>(numFeatures).fill(0);
    this.bias = 0;

    for (let epoch = 0; epoch < maxEpochs; epoch += 1) {
      const gradW = new Array<number>(numFeatures).fill(0);
      let gradB = 0;
      for (let i = 0; i < X.length; i += 1) {
        const residual = scaledY[i]! - (dot(this.weights, X[i]!) + this.bias);
        const gradient = residual >= 0 ? -quantile : 1 - quantile;
        for (let j = 0; j < numFeatures; j += 1) gradW[j] += gradient * X[i]![j]!;
        gradB += gradient;
      }
      for (let j = 0; j < numFeatures; j += 1) {
        this.weights[j] -= learningRate * (gradW[j]! / X.length + lambda * this.weights[j]!);
      }
      this.bias -= learningRate * gradB / X.length;
    }
  }

  predict(x: readonly number[]): number {
    return (dot(this.weights, x) + this.bias) * this.targetStd + this.targetMean;
  }
}

// --- Time-of-Day Conditional Prior (Baseline B2) ----------------------------

export class TimeOfDayPrior {
  private readonly meanByMinute = new Map<number, number>();
  private globalMean = 0;

  fit(minuteOfDays: readonly number[], returns: readonly number[]): void {
    const sumByMin = new Map<number, number>();
    const countByMin = new Map<number, number>();
    let totalSum = 0;

    for (let i = 0; i < returns.length; i += 1) {
      const m = minuteOfDays[i]!;
      const r = returns[i]!;
      sumByMin.set(m, (sumByMin.get(m) ?? 0) + r);
      countByMin.set(m, (countByMin.get(m) ?? 0) + 1);
      totalSum += r;
    }

    this.globalMean = returns.length > 0 ? totalSum / returns.length : 0;
    for (const [m, sum] of sumByMin.entries()) {
      const c = countByMin.get(m) ?? 1;
      this.meanByMinute.set(m, sum / c);
    }
  }

  predict(minuteOfDay: number): number {
    return this.meanByMinute.get(minuteOfDay) ?? this.globalMean;
  }
}

// --- Decile Monotonicity Diagnostic -----------------------------------------

export interface DecileRecord {
  readonly decile: number; // 1 to 10
  readonly count: number;
  readonly meanPredictedScore: number;
  readonly meanRealizedReturnBps: number;
  readonly hitRate: number; // fraction positive returns
}

export function computeDecileMonotonicity(
  predictedScores: readonly number[],
  realizedReturnsBps: readonly number[],
  numDeciles = 10,
): DecileRecord[] {
  const pairs: { score: number; ret: number }[] = [];
  const shared = Math.min(predictedScores.length, realizedReturnsBps.length);
  for (let i = 0; i < shared; i += 1) {
    const s = predictedScores[i]!;
    const r = realizedReturnsBps[i]!;
    if (Number.isFinite(s) && Number.isFinite(r)) {
      pairs.push({ score: s, ret: r });
    }
  }

  if (pairs.length === 0) return [];
  pairs.sort((a, b) => a.score - b.score);

  const decileSize = Math.floor(pairs.length / numDeciles);
  const deciles: DecileRecord[] = [];

  for (let d = 0; d < numDeciles; d += 1) {
    const start = d * decileSize;
    const end = d === numDeciles - 1 ? pairs.length : (d + 1) * decileSize;
    const chunk = pairs.slice(start, end);

    let scoreSum = 0;
    let retSum = 0;
    let posCount = 0;

    for (const p of chunk) {
      scoreSum += p.score;
      retSum += p.ret;
      if (p.ret > 0) posCount += 1;
    }

    const count = chunk.length || 1;
    deciles.push({
      decile: d + 1,
      count: chunk.length,
      meanPredictedScore: scoreSum / count,
      meanRealizedReturnBps: retSum / count,
      hitRate: posCount / count,
    });
  }

  return deciles;
}

// --- Evaluation Summary Structure -------------------------------------------

export interface LearnabilityEvaluation {
  readonly targetName: string;
  readonly horizonMinutes: 15 | 30 | 60;
  readonly modelType: string;
  readonly sampleCount: number;
  readonly oofSpearmanIc: InformationCoefficient;
  readonly oofResidualIc: InformationCoefficient; // vs B2 Time-of-Day prior
  readonly deciles: readonly DecileRecord[];
  readonly falsificationSuite?: FalsificationReport;
  readonly verdict: "PASS" | "INTERESTING" | "WEAK" | "REJECT";
}
