import type { StockIntelligenceHorizon } from "./data-quality.js";
import { horizonEndUtc, type CalibrationSource } from "./outcome-model.js";
import { utcDateKey } from "./returns.js";

export const DEFAULT_CALIBRATION_MIN_SAMPLES = 30;
export const DEFAULT_CALIBRATION_WINDOW_YEARS = 8;
export const CALIBRATION_BIN_COUNT = 10;

export interface CalibrationObservation {
  readonly asOf: string;
  readonly instrumentId: string;
  readonly regimeBucket: string | null;
  readonly rawProbability: number;
  readonly actualPositive: boolean;
}

export interface IsotonicCurve {
  readonly knots: readonly { readonly x: number; readonly y: number }[];
}

export interface FittedCalibration {
  readonly horizon: StockIntelligenceHorizon;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly nGlobal: number;
  readonly byRegime: Readonly<Record<string, { n: number; curve: IsotonicCurve }>>;
  readonly globalCurve: IsotonicCurve;
}

export interface AppliedCalibration {
  readonly calibratedProbability: number | null;
  readonly source: CalibrationSource;
  readonly nRegime: number;
  readonly nGlobal: number;
}

export interface ReliabilityBin {
  readonly binFrom: number;
  readonly binTo: number;
  readonly predictedMean: number;
  readonly actualRate: number;
  readonly n: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function mergeDuplicateX(points: readonly { x: number; y: number; weight: number }[]): { x: number; y: number; weight: number }[] {
  const sorted = [...points]
    .filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y) && row.weight > 0)
    .sort((a, b) => a.x - b.x);
  const merged: { x: number; y: number; weight: number }[] = [];
  for (const point of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-12) {
      const weight = last.weight + point.weight;
      last.y = (last.y * last.weight + point.y * point.weight) / weight;
      last.weight = weight;
    } else {
      merged.push({ ...point });
    }
  }
  return merged;
}

/**
 * Pool Adjacent Violators. Produces a non-decreasing curve of predicted vs observed.
 */
export function fitIsotonic(points: readonly { x: number; y: number; weight?: number }[]): IsotonicCurve {
  const merged = mergeDuplicateX(points.map((row) => ({
    x: row.x,
    y: row.y,
    weight: row.weight ?? 1,
  })));
  if (merged.length === 0) return { knots: [] };

  const blocks = merged.map((row) => ({
    sumY: row.y * row.weight,
    sumW: row.weight,
    xSum: row.x * row.weight,
  }));
  let index = 0;
  while (index < blocks.length - 1) {
    const current = blocks[index]!;
    const next = blocks[index + 1]!;
    if (current.sumY / current.sumW <= next.sumY / next.sumW + 1e-15) {
      index += 1;
      continue;
    }
    current.sumY += next.sumY;
    current.sumW += next.sumW;
    current.xSum += next.xSum;
    blocks.splice(index + 1, 1);
    if (index > 0) index -= 1;
  }

  return {
    knots: blocks.map((block) => ({
      x: block.xSum / block.sumW,
      y: clamp01(block.sumY / block.sumW),
    })),
  };
}

export function applyIsotonic(raw: number, curve: IsotonicCurve): number {
  const knots = curve.knots;
  if (knots.length === 0) return clamp01(raw);
  if (raw <= knots[0]!.x) return knots[0]!.y;
  const last = knots[knots.length - 1]!;
  if (raw >= last.x) return last.y;
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index]!;
    const left = knots[index - 1]!;
    if (raw <= right.x) {
      const span = right.x - left.x;
      const t = span === 0 ? 0 : (raw - left.x) / span;
      return clamp01(left.y + t * (right.y - left.y));
    }
  }
  return last.y;
}

export function calibrationWindowFrom(asOf: Date, years: number = DEFAULT_CALIBRATION_WINDOW_YEARS): Date {
  return new Date(Date.UTC(
    asOf.getUTCFullYear() - years,
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
    asOf.getUTCHours(),
    asOf.getUTCMinutes(),
    asOf.getUTCSeconds(),
    asOf.getUTCMilliseconds(),
  ));
}

export function isUsableTrainingObservation(
  observation: Pick<CalibrationObservation, "asOf">,
  queryAsOf: Date,
  horizon: StockIntelligenceHorizon,
  windowFrom: Date,
): boolean {
  const asOf = new Date(`${observation.asOf}T23:59:59.999Z`);
  if (asOf.getTime() >= queryAsOf.getTime()) return false;
  if (asOf.getTime() < windowFrom.getTime()) return false;
  return utcDateKey(horizonEndUtc(asOf, horizon)) <= utcDateKey(queryAsOf);
}

export function fitCalibration(input: {
  horizon: StockIntelligenceHorizon;
  queryAsOf: Date;
  observations: readonly CalibrationObservation[];
  minSamples?: number;
  windowYears?: number;
}): FittedCalibration {
  const windowFrom = calibrationWindowFrom(input.queryAsOf, input.windowYears ?? DEFAULT_CALIBRATION_WINDOW_YEARS);
  const usable = input.observations.filter((row) =>
    Number.isFinite(row.rawProbability)
    && isUsableTrainingObservation(row, input.queryAsOf, input.horizon, windowFrom)
  );
  const byRegime: Record<string, { n: number; curve: IsotonicCurve }> = {};
  const grouped = new Map<string, CalibrationObservation[]>();
  for (const row of usable) {
    const key = row.regimeBucket ?? "unknown";
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  for (const [bucket, rows] of grouped) {
    byRegime[bucket] = {
      n: rows.length,
      curve: fitIsotonic(rows.map((row) => ({
        x: row.rawProbability,
        y: row.actualPositive ? 1 : 0,
      }))),
    };
  }
  return {
    horizon: input.horizon,
    windowFrom: utcDateKey(windowFrom),
    windowTo: utcDateKey(input.queryAsOf),
    nGlobal: usable.length,
    byRegime,
    globalCurve: fitIsotonic(usable.map((row) => ({
      x: row.rawProbability,
      y: row.actualPositive ? 1 : 0,
    }))),
  };
}

export function applyCalibration(input: {
  rawProbability: number | null;
  regimeBucket: string | null;
  fitted: FittedCalibration;
  minSamples?: number;
}): AppliedCalibration {
  const minSamples = input.minSamples ?? DEFAULT_CALIBRATION_MIN_SAMPLES;
  if (input.rawProbability === null) {
    return { calibratedProbability: null, source: "none", nRegime: 0, nGlobal: input.fitted.nGlobal };
  }
  const bucket = input.regimeBucket ?? "unknown";
  const regime = input.fitted.byRegime[bucket];
  const nRegime = regime?.n ?? 0;
  if (regime && nRegime >= minSamples && regime.curve.knots.length > 0) {
    return {
      calibratedProbability: applyIsotonic(input.rawProbability, regime.curve),
      source: "regime_fit",
      nRegime,
      nGlobal: input.fitted.nGlobal,
    };
  }
  if (input.fitted.nGlobal >= minSamples && input.fitted.globalCurve.knots.length > 0) {
    return {
      calibratedProbability: applyIsotonic(input.rawProbability, input.fitted.globalCurve),
      source: "global_fallback",
      nRegime,
      nGlobal: input.fitted.nGlobal,
    };
  }
  return {
    calibratedProbability: input.rawProbability,
    source: "none",
    nRegime,
    nGlobal: input.fitted.nGlobal,
  };
}

export function reliabilityDiagram(
  observations: readonly { predicted: number; actualPositive: boolean }[],
  binCount: number = CALIBRATION_BIN_COUNT,
): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const binFrom = index / binCount;
    const binTo = (index + 1) / binCount;
    const inBin = observations.filter((row) => {
      if (index === binCount - 1) return row.predicted >= binFrom && row.predicted <= binTo;
      return row.predicted >= binFrom && row.predicted < binTo;
    });
    const n = inBin.length;
    bins.push({
      binFrom,
      binTo,
      predictedMean: n === 0 ? (binFrom + binTo) / 2 : inBin.reduce((sum, row) => sum + row.predicted, 0) / n,
      actualRate: n === 0 ? 0 : inBin.filter((row) => row.actualPositive).length / n,
      n,
    });
  }
  return bins;
}

export function expectedCalibrationError(bins: readonly ReliabilityBin[]): number {
  const n = bins.reduce((sum, bin) => sum + bin.n, 0);
  if (n === 0) return 1;
  return bins.reduce((sum, bin) => sum + (bin.n / n) * Math.abs(bin.predictedMean - bin.actualRate), 0);
}
