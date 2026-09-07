import type {
  DirectionLabel,
  AdaptiveLabelOutcome,
  TripleBarrierOutcome,
  MoveThenSideOutcome,
  PathEfficiencyOutcome,
  ContinuousReturnOutcome,
} from "./label-families.js";
import type { OverlapSummary } from "./concurrency-uniqueness.js";

/**
 * D0 Label-Quality Report Generator (Phase 29 §4, §6).
 *
 * Pre-ML Diagnostic Report covering:
 * - Class distribution & balance by year, time-of-day, and volatility regime
 * - 5m decision transition persistence matrix
 * - Cross-horizon momentum vs. exhaustion transition matrix
 * - Triple Barrier ambiguity rates
 * - Overlap-adjusted sample counts and uniqueness metrics
 */

export interface HorizonQualityReport {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly totalSamples: number;
  readonly classDistribution: {
    readonly upCount: number;
    readonly upPct: number;
    readonly neutralCount: number;
    readonly neutralPct: number;
    readonly downCount: number;
    readonly downPct: number;
  };
  readonly yearlyDistribution: ReadonlyMap<string, { upPct: number; neutralPct: number; downPct: number; total: number }>;
  readonly todDistribution: ReadonlyMap<string, { upPct: number; neutralPct: number; downPct: number; total: number }>;
  readonly volRegimeDistribution: ReadonlyMap<string, { upPct: number; neutralPct: number; downPct: number; total: number }>;
  readonly overlapSummary: OverlapSummary;
}

export interface TransitionMatrix {
  readonly fromUp: { up: number; neutral: number; down: number; total: number };
  readonly fromNeutral: { up: number; neutral: number; down: number; total: number };
  readonly fromDown: { up: number; neutral: number; down: number; total: number };
}

export interface TripleBarrierSummary {
  readonly horizonMinutes: 15 | 30 | 60;
  readonly totalSamples: number;
  readonly upperPct: number;
  readonly lowerPct: number;
  readonly timePct: number;
  readonly ambiguousPct: number;
  readonly ambiguousCount: number;
}

export interface D0QualityReport {
  readonly instrument: string;
  readonly totalSessions: number;
  readonly horizonReports: ReadonlyMap<15 | 30 | 60, HorizonQualityReport>;
  readonly decisionTransitionMatrix: ReadonlyMap<15 | 30 | 60, TransitionMatrix>;
  readonly crossHorizonTransitions: {
    readonly h15ToH30: ReadonlyMap<DirectionLabel, { up: number; neutral: number; down: number }>;
    readonly h30ToH60: ReadonlyMap<DirectionLabel, { up: number; neutral: number; down: number }>;
  };
  readonly tripleBarrierSummaries: ReadonlyMap<15 | 30 | 60, TripleBarrierSummary>;
  readonly overlapByTarget: ReadonlyMap<string, OverlapSummary>;
  readonly moveSideSummaries: ReadonlyMap<15 | 30 | 60, {
    totalSamples: number; movePct: number; upGivenMovePct: number; downGivenMovePct: number;
  }>;
  readonly pathEfficiencySummaries: ReadonlyMap<15 | 30 | 60, {
    totalSamples: number; meanSignedEfficiency: number; meanAbsoluteEfficiency: number; medianAbsoluteEfficiency: number;
  }>;
  readonly continuousReturnSummaries: ReadonlyMap<15 | 30 | 60, {
    totalSamples: number; meanRawReturnBps: number; standardDeviationRawReturnBps: number; meanVolNormalizedReturn: number;
  }>;
}

export interface LabeledRecord {
  readonly sampleId: string;
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly minuteOfDay: number;
  readonly expectedVolBps: number;
  readonly adaptive15?: AdaptiveLabelOutcome;
  readonly adaptive30?: AdaptiveLabelOutcome;
  readonly adaptive60?: AdaptiveLabelOutcome;
  readonly tb15?: TripleBarrierOutcome;
  readonly tb30?: TripleBarrierOutcome;
  readonly tb60?: TripleBarrierOutcome;
  readonly moveSide15?: MoveThenSideOutcome;
  readonly moveSide30?: MoveThenSideOutcome;
  readonly moveSide60?: MoveThenSideOutcome;
  readonly pathEff15?: PathEfficiencyOutcome;
  readonly pathEff30?: PathEfficiencyOutcome;
  readonly pathEff60?: PathEfficiencyOutcome;
  readonly continuous15?: ContinuousReturnOutcome;
  readonly continuous30?: ContinuousReturnOutcome;
  readonly continuous60?: ContinuousReturnOutcome;
}

function classifyTodBucket(minuteOfDay: number): "OPEN_0915_1030" | "MIDDAY_1030_1330" | "CLOSE_1330_1530" {
  if (minuteOfDay < 75) return "OPEN_0915_1030";
  if (minuteOfDay < 255) return "MIDDAY_1030_1330";
  return "CLOSE_1330_1530";
}

function computeClassDistribution(labels: readonly DirectionLabel[]): {
  upCount: number;
  upPct: number;
  neutralCount: number;
  neutralPct: number;
  downCount: number;
  downPct: number;
} {
  let up = 0;
  let neutral = 0;
  let down = 0;
  for (const l of labels) {
    if (l === "UP") up += 1;
    else if (l === "DOWN") down += 1;
    else neutral += 1;
  }
  const total = labels.length || 1;
  return {
    upCount: up,
    upPct: up / total,
    neutralCount: neutral,
    neutralPct: neutral / total,
    downCount: down,
    downPct: down / total,
  };
}

export function generateD0QualityReport(
  instrument: string,
  records: readonly LabeledRecord[],
  overlapSummaries: ReadonlyMap<15 | 30 | 60, OverlapSummary>,
  overlapByTarget: ReadonlyMap<string, OverlapSummary> = new Map(),
): D0QualityReport {
  const orderedRecords = [...records].sort((left, right) => left.decisionAt.getTime() - right.decisionAt.getTime());
  const uniqueSessions = new Set(orderedRecords.map((r) => r.sessionDate));

  // Determine volatility quantiles (25th and 75th)
  const volValues = orderedRecords.map((r) => r.expectedVolBps).sort((a, b) => a - b);
  const q25Vol = volValues[Math.floor(volValues.length * 0.25)] ?? 10;
  const q75Vol = volValues[Math.floor(volValues.length * 0.75)] ?? 25;

  const horizonReports = new Map<15 | 30 | 60, HorizonQualityReport>();
  const decisionTransitionMatrix = new Map<15 | 30 | 60, TransitionMatrix>();
  const tripleBarrierSummaries = new Map<15 | 30 | 60, TripleBarrierSummary>();
  const moveSideSummaries = new Map<15 | 30 | 60, { totalSamples: number; movePct: number; upGivenMovePct: number; downGivenMovePct: number }>();
  const pathEfficiencySummaries = new Map<15 | 30 | 60, { totalSamples: number; meanSignedEfficiency: number; meanAbsoluteEfficiency: number; medianAbsoluteEfficiency: number }>();
  const continuousReturnSummaries = new Map<15 | 30 | 60, { totalSamples: number; meanRawReturnBps: number; standardDeviationRawReturnBps: number; meanVolNormalizedReturn: number }>();

  for (const horizon of [15, 30, 60] as const) {
    const key = `adaptive${horizon}` as const;
    const validRecords = orderedRecords.filter((r) => r[key] !== undefined);
    const labels = validRecords.map((r) => r[key]!.label);
    const classDist = computeClassDistribution(labels);

    // Group by Year
    const yearGroups = new Map<string, DirectionLabel[]>();
    // Group by TOD
    const todGroups = new Map<string, DirectionLabel[]>();
    // Group by Vol Regime
    const volGroups = new Map<string, DirectionLabel[]>();

    for (const r of validRecords) {
      const year = r.sessionDate.slice(0, 4);
      let yList = yearGroups.get(year);
      if (!yList) {
        yList = [];
        yearGroups.set(year, yList);
      }
      yList.push(r[key]!.label);

      const tod = classifyTodBucket(r.minuteOfDay);
      let tList = todGroups.get(tod);
      if (!tList) {
        tList = [];
        todGroups.set(tod, tList);
      }
      tList.push(r[key]!.label);

      const volRegime = r.expectedVolBps < q25Vol ? "LOW_VOL" : r.expectedVolBps > q75Vol ? "HIGH_VOL" : "NORMAL_VOL";
      let vList = volGroups.get(volRegime);
      if (!vList) {
        vList = [];
        volGroups.set(volRegime, vList);
      }
      vList.push(r[key]!.label);
    }

    const yearlyDistribution = new Map<string, { upPct: number; neutralPct: number; downPct: number; total: number }>();
    for (const [y, list] of yearGroups.entries()) {
      const d = computeClassDistribution(list);
      yearlyDistribution.set(y, { upPct: d.upPct, neutralPct: d.neutralPct, downPct: d.downPct, total: list.length });
    }

    const todDistribution = new Map<string, { upPct: number; neutralPct: number; downPct: number; total: number }>();
    for (const [t, list] of todGroups.entries()) {
      const d = computeClassDistribution(list);
      todDistribution.set(t, { upPct: d.upPct, neutralPct: d.neutralPct, downPct: d.downPct, total: list.length });
    }

    const volRegimeDistribution = new Map<string, { upPct: number; neutralPct: number; downPct: number; total: number }>();
    for (const [v, list] of volGroups.entries()) {
      const d = computeClassDistribution(list);
      volRegimeDistribution.set(v, { upPct: d.upPct, neutralPct: d.neutralPct, downPct: d.downPct, total: list.length });
    }

    horizonReports.set(horizon, {
      horizonMinutes: horizon,
      totalSamples: validRecords.length,
      classDistribution: classDist,
      yearlyDistribution,
      todDistribution,
      volRegimeDistribution,
      overlapSummary: overlapSummaries.get(horizon) ?? {
        rawSampleCount: validRecords.length,
        overlapAdjustedSampleCount: validRecords.length,
        averageConcurrency: 1,
        medianConcurrency: 1,
        averageUniqueness: 1,
      },
    });

    // 5m Decision Transitions (within same session)
    const transitions = {
      fromUp: { up: 0, neutral: 0, down: 0, total: 0 },
      fromNeutral: { up: 0, neutral: 0, down: 0, total: 0 },
      fromDown: { up: 0, neutral: 0, down: 0, total: 0 },
    };

    for (let i = 1; i < validRecords.length; i += 1) {
      const prev = validRecords[i - 1]!;
      const cur = validRecords[i]!;
      // Only transition if same session and adjacent 5m decision
      if (prev.sessionDate === cur.sessionDate && (cur.minuteOfDay - prev.minuteOfDay) === 5) {
        const fromLabel = prev[key]!.label;
        const toLabel = cur[key]!.label;
        const bucket = fromLabel === "UP" ? transitions.fromUp : fromLabel === "DOWN" ? transitions.fromDown : transitions.fromNeutral;
        bucket.total += 1;
        if (toLabel === "UP") bucket.up += 1;
        else if (toLabel === "DOWN") bucket.down += 1;
        else bucket.neutral += 1;
      }
    }
    decisionTransitionMatrix.set(horizon, transitions);

    // Triple Barrier Summary
    const tbKey = `tb${horizon}` as const;
    const validTb = orderedRecords.filter((r) => r[tbKey] !== undefined);
    let upper = 0;
    let lower = 0;
    let time = 0;
    let amb = 0;
    for (const r of validTb) {
      const bo = r[tbKey]!.barrierOutcome;
      if (bo === "UPPER") upper += 1;
      else if (bo === "LOWER") lower += 1;
      else if (bo === "TIME") time += 1;
      else amb += 1;
    }
    const tbTotal = validTb.length || 1;
    tripleBarrierSummaries.set(horizon, {
      horizonMinutes: horizon,
      totalSamples: validTb.length,
      upperPct: upper / tbTotal,
      lowerPct: lower / tbTotal,
      timePct: time / tbTotal,
      ambiguousPct: amb / tbTotal,
      ambiguousCount: amb,
    });

    const moveKey = `moveSide${horizon}` as const;
    const moveOutcomes = orderedRecords.flatMap((record) => record[moveKey] ? [record[moveKey]!] : []);
    const moves = moveOutcomes.filter((outcome) => outcome.moveLabel === 1);
    const upMoves = moves.filter((outcome) => outcome.sideLabel === "UP").length;
    moveSideSummaries.set(horizon, {
      totalSamples: moveOutcomes.length,
      movePct: moveOutcomes.length > 0 ? moves.length / moveOutcomes.length : 0,
      upGivenMovePct: moves.length > 0 ? upMoves / moves.length : 0,
      downGivenMovePct: moves.length > 0 ? (moves.length - upMoves) / moves.length : 0,
    });

    const pathKey = `pathEff${horizon}` as const;
    const pathOutcomes = orderedRecords.flatMap((record) => record[pathKey] ? [record[pathKey]!] : []);
    const absoluteEfficiencies = pathOutcomes.map((outcome) => outcome.absolutePathEfficiency).sort((a, b) => a - b);
    pathEfficiencySummaries.set(horizon, {
      totalSamples: pathOutcomes.length,
      meanSignedEfficiency: pathOutcomes.length > 0
        ? pathOutcomes.reduce((sum, outcome) => sum + outcome.signedPathEfficiency, 0) / pathOutcomes.length
        : 0,
      meanAbsoluteEfficiency: pathOutcomes.length > 0
        ? pathOutcomes.reduce((sum, outcome) => sum + outcome.absolutePathEfficiency, 0) / pathOutcomes.length
        : 0,
      medianAbsoluteEfficiency: absoluteEfficiencies[Math.floor(absoluteEfficiencies.length / 2)] ?? 0,
    });

    const continuousKey = `continuous${horizon}` as const;
    const continuousOutcomes = orderedRecords.flatMap((record) => record[continuousKey] ? [record[continuousKey]!] : []);
    const meanRaw = continuousOutcomes.length > 0
      ? continuousOutcomes.reduce((sum, outcome) => sum + outcome.rawReturnBps, 0) / continuousOutcomes.length
      : 0;
    const rawVariance = continuousOutcomes.length > 1
      ? continuousOutcomes.reduce((sum, outcome) => sum + (outcome.rawReturnBps - meanRaw) ** 2, 0) / (continuousOutcomes.length - 1)
      : 0;
    continuousReturnSummaries.set(horizon, {
      totalSamples: continuousOutcomes.length,
      meanRawReturnBps: meanRaw,
      standardDeviationRawReturnBps: Math.sqrt(rawVariance),
      meanVolNormalizedReturn: continuousOutcomes.length > 0
        ? continuousOutcomes.reduce((sum, outcome) => sum + outcome.volNormalizedReturn, 0) / continuousOutcomes.length
        : 0,
    });
  }

  // Cross-horizon transitions (15m -> 30m, 30m -> 60m)
  const h15ToH30 = new Map<DirectionLabel, { up: number; neutral: number; down: number }>();
  for (const label of ["UP", "NEUTRAL", "DOWN"] as const) {
    h15ToH30.set(label, { up: 0, neutral: 0, down: 0 });
  }
  for (const r of orderedRecords) {
    if (r.adaptive15 && r.adaptive30) {
      const from = r.adaptive15.label;
      const to = r.adaptive30.label;
      const entry = h15ToH30.get(from)!;
      if (to === "UP") entry.up += 1;
      else if (to === "DOWN") entry.down += 1;
      else entry.neutral += 1;
    }
  }

  const h30ToH60 = new Map<DirectionLabel, { up: number; neutral: number; down: number }>();
  for (const label of ["UP", "NEUTRAL", "DOWN"] as const) {
    h30ToH60.set(label, { up: 0, neutral: 0, down: 0 });
  }
  for (const r of orderedRecords) {
    if (r.adaptive30 && r.adaptive60) {
      const from = r.adaptive30.label;
      const to = r.adaptive60.label;
      const entry = h30ToH60.get(from)!;
      if (to === "UP") entry.up += 1;
      else if (to === "DOWN") entry.down += 1;
      else entry.neutral += 1;
    }
  }

  return {
    instrument,
    totalSessions: uniqueSessions.size,
    horizonReports,
    decisionTransitionMatrix,
    crossHorizonTransitions: { h15ToH30, h30ToH60 },
    tripleBarrierSummaries,
    overlapByTarget,
    moveSideSummaries,
    pathEfficiencySummaries,
    continuousReturnSummaries,
  };
}
