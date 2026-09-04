import { expectedCalibrationError, reliabilityDiagram, type ReliabilityBin } from "./calibration.js";
import type { StockIntelligenceHorizon } from "./data-quality.js";
import type { ReturnDistribution } from "./outcome-model.js";
import { REPLAY_SURVIVORSHIP_LIMITATION, type ReplayJobSummary, type ReplayPairStatus } from "./replay.js";
import { stockIntelligenceVersions, type StockIntelligenceVersions } from "./versions.js";

export const GATE7_ECE_TOLERANCE = 0.10;
export const GATE7_REGIME_ECE_MIN_N = 10;
export const GATE7_BASELINE1_ALPHA = 0.05;
export const GATE7_BASELINE2_ALPHA = 0.10;
export const GATE7_SCENARIO_MIN_N = 20;
export const GATE7_SCENARIO_COVERAGE_TOLERANCE = 0.10;
export const GATE7_TAIL_MIN_N = 20;
export const GATE7_TAIL_RATE_MAX = 0.15;
export const GATE7_REGIME_MIN_BUCKETS = 2;
export const GATE7_REGIME_MIN_N = 10;
export const GATE7_REGIME_MAX_SHARE = 0.85;

export interface Gate7ForecastRow {
  readonly instrumentId: string;
  readonly asOf: string;
  readonly horizon: StockIntelligenceHorizon;
  readonly pairStatus: ReplayPairStatus;
  readonly regimeBucket: string | null;
  readonly investorFacing: boolean;
  readonly rawProbability: number | null;
  readonly calibratedProbability: number | null;
  readonly distribution: ReturnDistribution | null;
  readonly actualTotalReturn: number | null;
  readonly sameDateEligibleMedian: number | null;
  readonly sectorStable: boolean;
  readonly sectorIndexReturn?: number | null;
  readonly predictedBeatSector?: number | null;
}

export interface Gate7Criterion {
  readonly id: number;
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface Gate7BaselineReport {
  readonly nRealized: number;
  readonly unconditionalPositiveRate: number;
  readonly modelBrier: number | null;
  readonly baselineBrier: number | null;
  readonly brierBeatsBaseline: boolean | null;
  readonly bullishHitRate: number | null;
  readonly bullishN: number;
  readonly binomialPValue: number | null;
  readonly p50MaeModel: number | null;
  readonly p50MaeUnconditional: number | null;
  readonly baseline2Beats: boolean | null;
  readonly baseline3Evaluated: boolean;
  readonly baseline3SkipReason: string | null;
  readonly baseline3Beats: boolean | null;
}

export interface ScenarioCoverageReport {
  readonly n: number;
  readonly bearRate: number | null;
  readonly baseRate: number | null;
  readonly bullRate: number | null;
  readonly withinTolerance: boolean | null;
}

export interface TailRiskReport {
  readonly n: number;
  readonly leftTailRate: number | null;
  readonly withinTolerance: boolean | null;
}

export interface RegimeStabilityReport {
  readonly buckets: readonly { bucket: string; n: number; ece: number | null; share: number }[];
  readonly nBucketsScored: number;
  readonly maxShare: number | null;
  readonly stable: boolean | null;
}

export interface Gate7Enablement {
  readonly eligible: boolean;
  readonly reason: string;
}

export interface Gate7Report {
  readonly passed: boolean;
  readonly jobId: string;
  readonly horizon: StockIntelligenceHorizon;
  readonly evaluationAsOf: string;
  readonly pipelineVersions: StockIntelligenceVersions;
  readonly nForecasts: number;
  readonly nRealized: number;
  readonly nInvestorFacing: number;
  readonly censorship: ReplayJobSummary;
  readonly censoredBiasAssessment: string;
  readonly calibration: {
    readonly ece: number | null;
    readonly bins: readonly ReliabilityBin[];
    readonly withinTolerance: boolean | null;
    readonly byRegime: readonly { bucket: string; n: number; ece: number }[];
  };
  readonly scenarios: ScenarioCoverageReport;
  readonly tailRisk: TailRiskReport;
  readonly regimeStability: RegimeStabilityReport;
  readonly baselines: Gate7BaselineReport;
  readonly criteria: readonly Gate7Criterion[];
  readonly enablement: Gate7Enablement;
}

export interface Gate7AcceptanceReport {
  readonly passed: boolean;
  readonly evaluationAsOf: string;
  readonly jobId: string;
  readonly horizons: Readonly<Record<StockIntelligenceHorizon, Gate7Report>>;
  readonly criteria: readonly Gate7Criterion[];
  readonly censoredBiasAssessment: string;
  readonly enablement: Gate7Enablement;
}

function factorialRatioBinomialTerm(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  let term = 1;
  for (let i = 1; i <= k; i += 1) {
    term *= ((n - k + i) / i) * p / (1 - p);
  }
  return term * (1 - p) ** n;
}

/** Two-sided binomial p-value via exhaustive sum. Fine for Gate 7 sample sizes in tests. */
export function binomialTwoSidedPValue(successes: number, n: number, p0: number): number {
  if (n <= 0) return 1;
  const p = Math.min(1 - 1e-12, Math.max(1e-12, p0));
  const observed = factorialRatioBinomialTerm(n, successes, p);
  let tail = 0;
  for (let k = 0; k <= n; k += 1) {
    const mass = factorialRatioBinomialTerm(n, k, p);
    if (mass <= observed + 1e-15) tail += mass;
  }
  return Math.min(1, tail);
}

export function brierScore(rows: readonly { predicted: number; actual: 0 | 1 }[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + (row.predicted - row.actual) ** 2, 0) / rows.length;
}

function meanAbs(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
}

export const DEFAULT_CENSORED_BIAS_ASSESSMENT =
  "Eligible COMPLETE pairs are the only Gate 7 evaluation set. Current-roster membership "
  + "makes 2015–2024 pairs SKIPPED_INELIGIBLE, so realized analogue outcomes in that window "
  + "are not a survivorship-safe calibration sample. Delistings are kept when they appear. "
  + REPLAY_SURVIVORSHIP_LIMITATION;

export const BASELINE3_NOT_SCORED_REASON =
  "Baseline 3 needs PIT sector_history, sector_stable instruments, a sector-index return, "
  + "and a model probability that the stock beats that index. M01 does not emit P(stock > sector).";

export function versionsMatchCurrent(versions: StockIntelligenceVersions): boolean {
  return (Object.keys(stockIntelligenceVersions) as (keyof StockIntelligenceVersions)[])
    .every((key) => versions[key] === stockIntelligenceVersions[key]);
}

export function enablementDecision(passed: boolean, failedNames: readonly string[] = []): Gate7Enablement {
  if (passed) {
    return {
      eligible: true,
      reason: "All 10 Gate 7 criteria passed on both horizons. An operator may set STOCK_INTELLIGENCE_API_ENABLED and NEXT_PUBLIC_STOCK_INTELLIGENCE_ENABLED for internal use. This process does not write those flags.",
    };
  }
  const failed = failedNames.length > 0 ? ` Failed: ${failedNames.join("; ")}.` : "";
  return {
    eligible: false,
    reason: `Gate 7 has not passed. API and UI stay disabled.${failed}`,
  };
}

export function scenarioBucket(actual: number, distribution: ReturnDistribution): "bear" | "base" | "bull" {
  if (actual <= distribution.p25) return "bear";
  if (actual >= distribution.p75) return "bull";
  return "base";
}

export function scenarioCoverage(rows: readonly Gate7ForecastRow[]): ScenarioCoverageReport {
  const scored = rows.filter((row) => row.actualTotalReturn !== null && row.distribution);
  if (scored.length === 0) {
    return { n: 0, bearRate: null, baseRate: null, bullRate: null, withinTolerance: null };
  }
  let bear = 0;
  let base = 0;
  let bull = 0;
  for (const row of scored) {
    const bucket = scenarioBucket(row.actualTotalReturn!, row.distribution!);
    if (bucket === "bear") bear += 1;
    else if (bucket === "bull") bull += 1;
    else base += 1;
  }
  const n = scored.length;
  const bearRate = bear / n;
  const baseRate = base / n;
  const bullRate = bull / n;
  const withinTolerance = n >= GATE7_SCENARIO_MIN_N
    && Math.abs(bearRate - 0.25) <= GATE7_SCENARIO_COVERAGE_TOLERANCE
    && Math.abs(baseRate - 0.50) <= GATE7_SCENARIO_COVERAGE_TOLERANCE
    && Math.abs(bullRate - 0.25) <= GATE7_SCENARIO_COVERAGE_TOLERANCE;
  return { n, bearRate, baseRate, bullRate, withinTolerance };
}

export function tailRisk(rows: readonly Gate7ForecastRow[]): TailRiskReport {
  const scored = rows.filter((row) => row.actualTotalReturn !== null && row.distribution);
  if (scored.length === 0) {
    return { n: 0, leftTailRate: null, withinTolerance: null };
  }
  const left = scored.filter((row) => row.actualTotalReturn! <= row.distribution!.p10).length;
  const leftTailRate = left / scored.length;
  const withinTolerance = scored.length >= GATE7_TAIL_MIN_N && leftTailRate <= GATE7_TAIL_RATE_MAX;
  return { n: scored.length, leftTailRate, withinTolerance };
}

function eceFor(rows: readonly { predicted: number; actualPositive: boolean }[]): number | null {
  if (rows.length === 0) return null;
  return expectedCalibrationError(reliabilityDiagram(rows));
}

export function regimeStability(rows: readonly Gate7ForecastRow[]): RegimeStabilityReport {
  const realized = rows.filter((row) => (
    row.actualTotalReturn !== null
    && row.calibratedProbability !== null
  ));
  const grouped = new Map<string, Gate7ForecastRow[]>();
  for (const row of realized) {
    const key = row.regimeBucket ?? "unknown";
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  const total = realized.length;
  const buckets = [...grouped.entries()].map(([bucket, members]) => {
    const reliability = members.map((row) => ({
      predicted: row.calibratedProbability!,
      actualPositive: row.actualTotalReturn! > 0,
    }));
    return {
      bucket,
      n: members.length,
      ece: eceFor(reliability),
      share: total === 0 ? 0 : members.length / total,
    };
  }).sort((a, b) => b.n - a.n);
  const scored = buckets.filter((row) => row.n >= GATE7_REGIME_MIN_N);
  const maxShare = scored.length === 0 ? null : Math.max(...scored.map((row) => row.share));
  const eceOk = scored.every((row) => row.ece !== null && row.ece <= GATE7_ECE_TOLERANCE);
  const stable = scored.length >= GATE7_REGIME_MIN_BUCKETS
    && maxShare !== null
    && maxShare <= GATE7_REGIME_MAX_SHARE
    && eceOk;
  return { buckets, nBucketsScored: scored.length, maxShare, stable };
}

export function evaluateGate7(input: {
  evaluationAsOf: string;
  censorship: ReplayJobSummary;
  forecasts: readonly Gate7ForecastRow[];
  censoredBiasAssessment?: string;
  horizon?: StockIntelligenceHorizon;
  pipelineVersions?: StockIntelligenceVersions;
}): Gate7Report {
  const horizon = input.horizon ?? input.forecasts[0]?.horizon ?? "6M";
  const pipelineVersions = input.pipelineVersions ?? stockIntelligenceVersions;
  const realized = input.forecasts.filter((row) => (
    row.pairStatus === "COMPLETE"
    && row.actualTotalReturn !== null
    && Number.isFinite(row.actualTotalReturn)
  ));
  const withProbability = realized.filter((row) => row.calibratedProbability !== null);
  const positives = realized.filter((row) => row.actualTotalReturn! > 0).length;
  const p0 = realized.length === 0 ? 0 : positives / realized.length;

  const brierRows = withProbability.map((row) => ({
    predicted: row.calibratedProbability!,
    actual: (row.actualTotalReturn! > 0 ? 1 : 0) as 0 | 1,
  }));
  const modelBrier = brierRows.length === 0 ? null : brierScore(brierRows);
  const baselineBrier = brierRows.length === 0 ? null : brierScore(brierRows.map((row) => ({
    predicted: p0,
    actual: row.actual,
  })));
  const brierBeats = modelBrier !== null && baselineBrier !== null ? modelBrier < baselineBrier : null;

  const bullish = withProbability.filter((row) => row.calibratedProbability! > 0.5);
  const bullishHits = bullish.filter((row) => row.actualTotalReturn! > 0).length;
  const binomialP = bullish.length === 0 ? null : binomialTwoSidedPValue(bullishHits, bullish.length, p0 || 0.5);

  const maeModel = realized
    .filter((row) => row.distribution)
    .map((row) => Math.abs(row.actualTotalReturn! - row.distribution!.p50));
  const maeUncond = realized
    .filter((row) => row.sameDateEligibleMedian !== null)
    .map((row) => Math.abs(row.actualTotalReturn! - row.sameDateEligibleMedian!));
  const baseline2Beats = maeModel.length > 0 && maeUncond.length > 0
    ? meanAbs(maeModel) < meanAbs(maeUncond)
    : null;

  const sectorRows = realized.filter((row) => (
    row.sectorStable
    && row.sectorIndexReturn != null
    && row.predictedBeatSector != null
  ));
  const baseline3Evaluated = sectorRows.length > 0;
  let baseline3Beats: boolean | null = null;
  if (baseline3Evaluated) {
    const sectorActual = sectorRows.map((row) => ({
      predicted: row.predictedBeatSector!,
      actual: (row.actualTotalReturn! > row.sectorIndexReturn! ? 1 : 0) as 0 | 1,
    }));
    const sectorP0 = sectorActual.reduce((sum, row) => sum + row.actual, 0) / sectorActual.length;
    const model = brierScore(sectorActual);
    const base = brierScore(sectorActual.map((row) => ({ predicted: sectorP0, actual: row.actual })));
    baseline3Beats = model < base;
  }

  const reliabilityRows = withProbability.map((row) => ({
    predicted: row.calibratedProbability!,
    actualPositive: row.actualTotalReturn! > 0,
  }));
  const bins = reliabilityDiagram(reliabilityRows);
  const ece = reliabilityRows.length === 0 ? null : expectedCalibrationError(bins);
  const byRegime = new Map<string, typeof reliabilityRows>();
  for (const row of withProbability) {
    const key = row.regimeBucket ?? "unknown";
    const current = byRegime.get(key) ?? [];
    current.push({
      predicted: row.calibratedProbability!,
      actualPositive: row.actualTotalReturn! > 0,
    });
    byRegime.set(key, current);
  }
  const regimeEce = [...byRegime.entries()]
    .filter(([, rows]) => rows.length >= GATE7_REGIME_ECE_MIN_N)
    .map(([bucket, rows]) => ({
      bucket,
      n: rows.length,
      ece: expectedCalibrationError(reliabilityDiagram(rows)),
    }));
  const calibrationOk = ece !== null
    && ece <= GATE7_ECE_TOLERANCE
    && regimeEce.every((row) => row.ece <= GATE7_ECE_TOLERANCE);

  const scenarios = scenarioCoverage(realized);
  const tails = tailRisk(realized);
  const regimes = regimeStability(withProbability.map((row) => row));
  const nPitFailed = input.censorship.nPitFailed;
  const nInvestorFacing = input.forecasts.filter((row) => row.investorFacing).length;
  const reproducible = versionsMatchCurrent(pipelineVersions)
    && (input.forecasts.length === 0 || input.forecasts.every((row) => row.horizon === horizon));

  const criteria: Gate7Criterion[] = [
    {
      id: 1,
      name: "No look-ahead bias",
      passed: nPitFailed === 0 && input.censorship.nSimulated > 0,
      detail: nPitFailed === 0
        ? "Replay PIT audit reported no leaked bars."
        : `${nPitFailed} pairs failed the PIT bar audit.`,
    },
    {
      id: 2,
      name: "No survivorship bias",
      passed: input.censorship.nFullyEvaluated > 0 && input.censorship.nCensored === 0,
      detail: input.censorship.nFullyEvaluated === 0
        ? "No COMPLETE eligible pairs; current-roster snapshot censors 2015–2024."
        : `${input.censorship.nCensored} of ${input.censorship.nSimulated} pairs were censored.`,
    },
    {
      id: 3,
      name: "Probability calibration acceptable",
      passed: calibrationOk,
      detail: ece === null
        ? "No realized COMPLETE forecasts to score."
        : `ECE=${ece.toFixed(3)} (tolerance ${GATE7_ECE_TOLERANCE}); `
          + `${regimeEce.length} regime bucket(s) with n>=${GATE7_REGIME_ECE_MIN_N}.`,
    },
    {
      id: 4,
      name: "Better than Baseline 1",
      passed: brierBeats === true && (binomialP === null || binomialP < GATE7_BASELINE1_ALPHA),
      detail: brierBeats === null
        ? "Insufficient realized probabilities."
        : `Brier model=${modelBrier?.toFixed(3)} vs base-rate=${baselineBrier?.toFixed(3)}; binomial p=${binomialP?.toFixed(3) ?? "n/a"}.`,
    },
    {
      id: 5,
      name: "Better than Baseline 2",
      passed: baseline2Beats === true,
      detail: baseline2Beats === null
        ? "Need same-date eligible medians on realized COMPLETE pairs."
        : `MAE p50=${meanAbs(maeModel).toFixed(3)} vs same-date median=${meanAbs(maeUncond).toFixed(3)}.`,
    },
    {
      id: 6,
      name: "Better than Baseline 3",
      passed: baseline3Beats === true,
      detail: baseline3Evaluated
        ? `Sector-relative Brier ${baseline3Beats ? "beats" : "does not beat"} the unconditional sector beat-rate.`
        : BASELINE3_NOT_SCORED_REASON,
    },
    {
      id: 7,
      name: "Scenario coverage acceptable",
      passed: scenarios.withinTolerance === true,
      detail: scenarios.n < GATE7_SCENARIO_MIN_N
        ? `Need ${GATE7_SCENARIO_MIN_N} realized COMPLETE outcomes with bands; have ${scenarios.n}.`
        : `bear=${scenarios.bearRate?.toFixed(3)} base=${scenarios.baseRate?.toFixed(3)} bull=${scenarios.bullRate?.toFixed(3)} (expected 0.25/0.50/0.25).`,
    },
    {
      id: 8,
      name: "Tail-risk behavior acceptable",
      passed: tails.withinTolerance === true,
      detail: tails.n < GATE7_TAIL_MIN_N
        ? `Need ${GATE7_TAIL_MIN_N} realized outcomes to score left-tail coverage; have ${tails.n}.`
        : `P(actual <= p10)=${tails.leftTailRate?.toFixed(3)} (max ${GATE7_TAIL_RATE_MAX}).`,
    },
    {
      id: 9,
      name: "Performance stable across regimes",
      passed: regimes.stable === true,
      detail: regimes.nBucketsScored < GATE7_REGIME_MIN_BUCKETS
        ? `Need COMPLETE pairs in at least ${GATE7_REGIME_MIN_BUCKETS} regime buckets with n>=${GATE7_REGIME_MIN_N}.`
        : `Scored ${regimes.nBucketsScored} buckets; max share=${regimes.maxShare?.toFixed(3)}.`,
    },
    {
      id: 10,
      name: "Results reproducible",
      passed: reproducible,
      detail: reproducible
        ? `Pipeline versions match ${pipelineVersions.outcomeModel}/${pipelineVersions.calibrationModel}.`
        : "Replay pipeline versions do not match the current v0.1 stamp, or horizon rows are mixed.",
    },
  ];

  const passed = criteria.every((row) => row.passed);
  const enablement = enablementDecision(passed, criteria.filter((row) => !row.passed).map((row) => `${row.id} ${row.name}`));

  return {
    passed,
    jobId: input.censorship.jobId,
    horizon,
    evaluationAsOf: input.evaluationAsOf,
    pipelineVersions,
    nForecasts: input.forecasts.length,
    nRealized: realized.length,
    nInvestorFacing,
    censorship: input.censorship,
    censoredBiasAssessment: input.censoredBiasAssessment ?? DEFAULT_CENSORED_BIAS_ASSESSMENT,
    calibration: {
      ece,
      bins,
      withinTolerance: ece === null ? null : calibrationOk,
      byRegime: regimeEce,
    },
    scenarios,
    tailRisk: tails,
    regimeStability: regimes,
    baselines: {
      nRealized: realized.length,
      unconditionalPositiveRate: p0,
      modelBrier,
      baselineBrier,
      brierBeatsBaseline: brierBeats,
      bullishHitRate: bullish.length === 0 ? null : bullishHits / bullish.length,
      bullishN: bullish.length,
      binomialPValue: binomialP,
      p50MaeModel: maeModel.length === 0 ? null : meanAbs(maeModel),
      p50MaeUnconditional: maeUncond.length === 0 ? null : meanAbs(maeUncond),
      baseline2Beats,
      baseline3Evaluated,
      baseline3SkipReason: baseline3Evaluated ? null : BASELINE3_NOT_SCORED_REASON,
      baseline3Beats,
    },
    criteria,
    enablement,
  };
}

export function combineGate7Reports(reports: readonly Gate7Report[]): Gate7AcceptanceReport {
  if (reports.length === 0) {
    throw new Error("combineGate7Reports requires at least one horizon report.");
  }
  const byHorizon = {} as Record<StockIntelligenceHorizon, Gate7Report>;
  for (const report of reports) byHorizon[report.horizon] = report;
  const passed = reports.every((row) => row.passed);
  const mergedCriteria = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => {
    const rows = reports.map((report) => report.criteria.find((row) => row.id === id)!);
    const first = rows[0]!;
    return {
      id,
      name: first.name,
      passed: rows.every((row) => row.passed),
      detail: reports.map((report) => `${report.horizon}: ${report.criteria.find((row) => row.id === id)?.detail}`).join(" | "),
    };
  });
  return {
    passed,
    evaluationAsOf: reports[0]!.evaluationAsOf,
    jobId: reports[0]!.jobId,
    horizons: byHorizon,
    criteria: mergedCriteria,
    censoredBiasAssessment: reports[0]!.censoredBiasAssessment,
    enablement: enablementDecision(passed, mergedCriteria.filter((row) => !row.passed).map((row) => `${row.id} ${row.name}`)),
  };
}
