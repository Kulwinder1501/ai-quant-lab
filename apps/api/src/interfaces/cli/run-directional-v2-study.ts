import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import { createStandardNseSession, type MarketSession, type SessionCandle } from "../../modules/research/directional-v2/domain/session-calendar.js";
import { phase29ExcludedSpecialSessionMap } from "../../modules/research/directional-v2/domain/excluded-special-sessions.js";
import {
  phase29DataQualityCandleExclusionMap,
  phase29DataQualitySessionExclusionMap,
} from "../../modules/research/directional-v2/domain/data-quality-exclusions.js";
import { generateDirectionalDataset } from "../../modules/research/directional-v2/application/generate-directional-dataset.js";
import { auditDirectionalCandles } from "../../modules/research/directional-v2/application/audit-directional-candles.js";
import { generateD0QualityReport, type D0QualityReport } from "../../modules/research/directional-v2/domain/label-quality-report.js";
import { runD1LearnabilityStudy, type D1StudyResult } from "../../modules/research/directional-v2/application/run-d1-learnability-study.js";

/**
 * Phase 29: Directional Intelligence V2 Study (D0 Label Study + D1 Learnability Baselines).
 *
 * Usage:
 *   node --loader ts-node/esm apps/api/src/interfaces/cli/run-directional-v2-study.ts
 *        [--symbols=NIFTYBEES,BANKBEES] [--folds=5] [--seed=42]
 */

interface CliOptions {
  symbols: string[];
  maxSessions?: number;
  numFolds: number;
  seed: number;
  kMultiplier: number;
  outputDir: string;
}

const FROZEN_K_MULTIPLIER = 0.5;
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("../../../../../logs/directional-v2/", import.meta.url));

function parseCliOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }

  const symbolsRaw = values.get("symbols") ?? "NIFTYBEES,BANKBEES";
  const symbols = symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const numFolds = Number(values.get("folds") ?? 5);
  const seed = Number(values.get("seed") ?? 42);
  const kMultiplier = Number(values.get("k") ?? FROZEN_K_MULTIPLIER);
  const maxSessionsRaw = values.get("max-sessions");
  const maxSessions = maxSessionsRaw ? Number(maxSessionsRaw) : undefined;

  if (symbols.length === 0) throw new Error("At least one symbol is required.");
  const frozenPair = [...symbols].sort().join(",");
  if (frozenPair !== "BANKBEES,NIFTYBEES") {
    throw new Error("Phase 29 D0/D1 is pre-registered for exactly NIFTYBEES,BANKBEES.");
  }
  if (!Number.isInteger(numFolds) || numFolds < 2) throw new Error("--folds must be an integer >= 2.");
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer.");
  if (!Number.isFinite(kMultiplier) || kMultiplier <= 0) throw new Error("--k must be positive and finite.");
  if (kMultiplier !== FROZEN_K_MULTIPLIER) {
    throw new Error(`Phase 29 is frozen at --k=${FROZEN_K_MULTIPLIER}; revise the protocol before changing it.`);
  }
  if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions <= 0)) {
    throw new Error("--max-sessions must be a positive integer.");
  }
  if (maxSessions !== undefined) {
    throw new Error("--max-sessions is non-canonical and disabled for the frozen Phase 29 study.");
  }

  return {
    symbols,
    maxSessions,
    numFolds,
    seed,
    kMultiplier,
    outputDir: values.get("output-dir") ?? DEFAULT_OUTPUT_DIR,
  };
}

async function loadCandlesForSymbol(
  database: DatabasePool,
  symbol: string,
  maxSessions?: number,
): Promise<SessionCandle[]> {
  let sessionDateFilter = "";
  if (maxSessions && maxSessions > 0) {
    const sessionRes = await database.query<{ sdate: Date | string }>(`
      SELECT DISTINCT (open_time AT TIME ZONE 'Asia/Kolkata')::date AS sdate
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
      ORDER BY sdate DESC
      LIMIT $2
    `, [symbol, maxSessions]);
    const dates = sessionRes.rows.map((r) => (
      r.sdate instanceof Date ? r.sdate.toISOString().slice(0, 10) : String(r.sdate).slice(0, 10)
    )).sort();
    if (dates.length > 0) {
      sessionDateFilter = `AND (c.open_time AT TIME ZONE 'Asia/Kolkata')::date >= '${dates[0]}'`;
    }
  }

  const res = await database.query<{
    open_time: Date; close_time: Date; open: string; high: string; low: string; close: string; volume: string | null;
  }>(`
    SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE
      ${sessionDateFilter}
    ORDER BY c.open_time ASC
  `, [symbol]);

  return res.rows.map((r) => ({
    openTime: new Date(r.open_time),
    closeTime: new Date(r.close_time),
    open: Number.parseFloat(String(r.open)),
    high: Number.parseFloat(String(r.high)),
    low: Number.parseFloat(String(r.low)),
    close: Number.parseFloat(String(r.close)),
    volume: Number.parseFloat(String(r.volume || "0")),
  }));
}

async function loadExpectedSessions(
  database: DatabasePool,
  candles: readonly SessionCandle[],
  instrument: string,
): Promise<MarketSession[]> {
  if (candles.length === 0) return [];
  const first = candles[0]!.openTime;
  const last = candles[candles.length - 1]!.openTime;
  const firstDate = new Date(first.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const lastDate = new Date(last.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const result = await database.query<{ session_date: string }>(`
    SELECT day::date::text AS session_date
    FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS dates(day)
    WHERE EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5
      AND NOT EXISTS (
        SELECT 1 FROM nse_holidays holiday WHERE holiday.holiday_date = day::date
      )
    ORDER BY day ASC
  `, [firstDate, lastDate]);
  const excludedSpecialSessions = phase29ExcludedSpecialSessionMap();
  const excludedDataQualitySessions = phase29DataQualitySessionExclusionMap(instrument);
  return result.rows
    .filter((row) => (
      !excludedSpecialSessions.has(row.session_date)
      && !excludedDataQualitySessions.has(row.session_date)
    ))
    .map((row) => createStandardNseSession(row.session_date));
}

async function assertAuditedSeriesProvenance(database: DatabasePool, symbol: string): Promise<void> {
  const result = await database.query<{ declared_source: string; actual_sources: Array<string | null> }>(`
    SELECT p.source AS declared_source, array_agg(DISTINCT c.source ORDER BY c.source) AS actual_sources
    FROM instruments i
    JOIN candle_series_provenance p ON p.instrument_id = i.id AND p.timeframe = '1m'
    LEFT JOIN candles c ON c.instrument_id = i.id AND c.timeframe = '1m'
    WHERE i.symbol = $1
    GROUP BY p.source
  `, [symbol]);
  const row = result.rows[0];
  const actualSources = row?.actual_sources ?? [];
  if (row?.declared_source !== "fyers-api-v3" || actualSources.some((source) => source !== "fyers-api-v3")) {
    throw new Error(
      `${symbol} 1m provenance must be exclusively fyers-api-v3; declared=${row?.declared_source ?? "missing"}`
      + ` actual=${actualSources.join(",") || "missing"}.`,
    );
  }
}

function printD0Report(report: D0QualityReport): void {
  console.info("======================================================================================");
  console.info(`DIRECTIONAL INTELLIGENCE V2 — D0 LABEL STUDY REPORT: ${report.instrument}`);
  console.info(`Sessions Evaluated: ${report.totalSessions}`);
  console.info("======================================================================================\n");

  console.info("1. D0-A ADAPTIVE HORIZON CLASS DISTRIBUTION");
  console.info("--------------------------------------------------------------------------------------");
  console.info("HORIZON     TOTAL SAMPLES     UP (%)         NEUTRAL (%)    DOWN (%)       STABILITY");
  console.info("--------------------------------------------------------------------------------------");
  for (const [horizon, hr] of report.horizonReports.entries()) {
    const cd = hr.classDistribution;
    const hStr = `${horizon}m`.padEnd(11);
    const totStr = String(hr.totalSamples).padEnd(17);
    const upStr = `${(cd.upPct * 100).toFixed(1)}%`.padEnd(14);
    const neuStr = `${(cd.neutralPct * 100).toFixed(1)}%`.padEnd(14);
    const downStr = `${(cd.downPct * 100).toFixed(1)}%`.padEnd(14);
    const diff = Math.abs(cd.upPct - cd.downPct);
    const stab = diff < 0.05 ? "BALANCED" : diff < 0.12 ? "MODERATE" : "IMBALANCED";
    console.info(`${hStr} ${totStr} ${upStr} ${neuStr} ${downStr} ${stab}`);
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("D0-C / D0-D / D0-E TARGET DIAGNOSTICS");
  console.info("--------------------------------------------------------------------------------------");
  for (const horizon of [15, 30, 60] as const) {
    const path = report.pathEfficiencySummaries.get(horizon)!;
    const continuous = report.continuousReturnSummaries.get(horizon)!;
    const move = report.moveSideSummaries.get(horizon)!;
    console.info(
      `${horizon}m path |mean|=${path.meanAbsoluteEfficiency.toFixed(3)} median|eff|=${path.medianAbsoluteEfficiency.toFixed(3)}`
      + ` | return mean=${continuous.meanRawReturnBps.toFixed(2)}bps sd=${continuous.standardDeviationRawReturnBps.toFixed(2)}bps`
      + ` | MOVE=${(move.movePct * 100).toFixed(1)}% UP|MOVE=${(move.upGivenMovePct * 100).toFixed(1)}%`,
    );
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("TARGET-SPECIFIC OVERLAP (INCLUDING EARLY TRIPLE-BARRIER RESOLUTION)");
  console.info("--------------------------------------------------------------------------------------");
  console.info("TARGET             RAW       AVG CONCURRENCY    AVG UNIQUENESS    OVERLAP-ADJ COUNT");
  for (const [target, overlap] of report.overlapByTarget.entries()) {
    console.info(
      `${target.padEnd(18)} ${String(overlap.rawSampleCount).padEnd(9)}`
      + ` ${overlap.averageConcurrency.toFixed(2).padEnd(18)}`
      + ` ${overlap.averageUniqueness.toFixed(3).padEnd(17)}`
      + ` ${overlap.overlapAdjustedSampleCount.toFixed(1)}`,
    );
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("2. D0-B TRIPLE BARRIER OUTCOMES & AMBIGUITY RATE");
  console.info("--------------------------------------------------------------------------------------");
  console.info("HORIZON     UPPER (%)      LOWER (%)      TIME (%)       AMBIGUOUS (%)   AMBIGUOUS COUNT");
  console.info("--------------------------------------------------------------------------------------");
  for (const [horizon, tb] of report.tripleBarrierSummaries.entries()) {
    const hStr = `${horizon}m`.padEnd(11);
    const upStr = `${(tb.upperPct * 100).toFixed(1)}%`.padEnd(14);
    const lowStr = `${(tb.lowerPct * 100).toFixed(1)}%`.padEnd(14);
    const timeStr = `${(tb.timePct * 100).toFixed(1)}%`.padEnd(14);
    const ambStr = `${(tb.ambiguousPct * 100).toFixed(1)}%`.padEnd(15);
    const ambCnt = String(tb.ambiguousCount);
    console.info(`${hStr} ${upStr} ${lowStr} ${timeStr} ${ambStr} ${ambCnt}`);
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("3. OVERLAP, CONCURRENCY & UNIQUE SAMPLE COUNT");
  console.info("--------------------------------------------------------------------------------------");
  console.info("HORIZON     RAW SAMPLES    AVG CONCURRENCY    MEDIAN CONC.   AVG UNIQUENESS  OVERLAP-ADJ COUNT");
  console.info("--------------------------------------------------------------------------------------");
  for (const [horizon, hr] of report.horizonReports.entries()) {
    const os = hr.overlapSummary;
    const hStr = `${horizon}m`.padEnd(11);
    const rawStr = String(os.rawSampleCount).padEnd(14);
    const avgC = os.averageConcurrency.toFixed(1).padEnd(18);
    const medC = os.medianConcurrency.toFixed(1).padEnd(14);
    const avgU = os.averageUniqueness.toFixed(2).padEnd(15);
    const adjC = os.overlapAdjustedSampleCount.toFixed(1);
    console.info(`${hStr} ${rawStr} ${avgC} ${medC} ${avgU} ${adjC}`);
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("4. 5m DECISION TRANSITION MATRIX (ADJACENT DECISIONS)");
  console.info("--------------------------------------------------------------------------------------");
  for (const [horizon, tm] of report.decisionTransitionMatrix.entries()) {
    const uTot = tm.fromUp.total || 1;
    const nTot = tm.fromNeutral.total || 1;
    const dTot = tm.fromDown.total || 1;
    console.info(`Horizon ${horizon}m:`);
    console.info(`  P(UP -> UP):      ${((tm.fromUp.up / uTot) * 100).toFixed(1)}%   | P(UP -> NEUTRAL):      ${((tm.fromUp.neutral / uTot) * 100).toFixed(1)}%   | P(UP -> DOWN):      ${((tm.fromUp.down / uTot) * 100).toFixed(1)}%`);
    console.info(`  P(NEU -> UP):     ${((tm.fromNeutral.up / nTot) * 100).toFixed(1)}%   | P(NEU -> NEUTRAL):     ${((tm.fromNeutral.neutral / nTot) * 100).toFixed(1)}%   | P(NEU -> DOWN):     ${((tm.fromNeutral.down / nTot) * 100).toFixed(1)}%`);
    console.info(`  P(DOWN -> UP):    ${((tm.fromDown.up / dTot) * 100).toFixed(1)}%   | P(DOWN -> NEUTRAL):    ${((tm.fromDown.neutral / dTot) * 100).toFixed(1)}%   | P(DOWN -> DOWN):    ${((tm.fromDown.down / dTot) * 100).toFixed(1)}%`);
  }
  console.info("--------------------------------------------------------------------------------------\n");

  console.info("5. CLASS STABILITY BY YEAR / TIME OF DAY / VOLATILITY REGIME");
  for (const [horizon, horizonReport] of report.horizonReports.entries()) {
    const render = (groups: ReadonlyMap<string, { upPct: number; neutralPct: number; downPct: number; total: number }>) => (
      [...groups.entries()].map(([name, values]) => (
        `${name}: U${(values.upPct * 100).toFixed(1)}/N${(values.neutralPct * 100).toFixed(1)}`
        + `/D${(values.downPct * 100).toFixed(1)} n=${values.total}`
      )).join(" | ")
    );
    console.info(`${horizon}m YEAR: ${render(horizonReport.yearlyDistribution)}`);
    console.info(`${horizon}m TOD:  ${render(horizonReport.todDistribution)}`);
    console.info(`${horizon}m VOL:  ${render(horizonReport.volRegimeDistribution)}`);
  }
  console.info("--------------------------------------------------------------------------------------\n");

  const renderCrossHorizon = (
    name: string,
    transitions: ReadonlyMap<string, { up: number; neutral: number; down: number }>,
  ): void => {
    console.info(`${name}: ${[...transitions.entries()].map(([from, to]) => (
      `${from}->U${to.up}/N${to.neutral}/D${to.down}`
    )).join(" | ")}`);
  };
  console.info("6. CROSS-HORIZON MOMENTUM / REVERSAL COUNTS");
  renderCrossHorizon("15m->30m", report.crossHorizonTransitions.h15ToH30);
  renderCrossHorizon("30m->60m", report.crossHorizonTransitions.h30ToH60);
  console.info("--------------------------------------------------------------------------------------\n");
}

function printD1Report(result: D1StudyResult): void {
  console.info("======================================================================================");
  console.info(`DIRECTIONAL INTELLIGENCE V2 — D1 LEARNABILITY BASELINES: ${result.instrument}`);
  console.info(`Total Eligible Samples: ${result.totalEligibleSamples}`);
  console.info("======================================================================================\n");

  console.info("D1 EVALUATION MATRIX (PURGED OUT-OF-FOLD ONLY)");
  console.info("--------------------------------------------------------------------------------------------------------------------");
  console.info("TARGET                 HORIZON  MODEL                PURGED OOF IC   95% DAY-BOOT CI      RESIDUAL IC    VERDICT");
  console.info("--------------------------------------------------------------------------------------------------------------------");

  for (const ev of result.evaluations) {
    const tgt = ev.targetName.padEnd(22);
    const h = `${ev.horizonMinutes}m`.padEnd(8);
    const mod = ev.modelType.padEnd(20);
    const icVal = ev.oofSpearmanIc.ic !== null ? ev.oofSpearmanIc.ic.toFixed(4) : "N/A";
    const icStr = icVal.padStart(13).padEnd(15);
    const ci = ev.oofSpearmanIc.confidenceInterval;
    const ciStr = ci ? `[${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}]` : "N/A";
    const ciPadded = ciStr.padEnd(20);
    const resVal = ev.oofResidualIc.ic !== null ? ev.oofResidualIc.ic.toFixed(4) : "N/A";
    const resStr = resVal.padStart(12).padEnd(14);
    const harness = ev.falsificationSuite?.verdict ?? "MISSING";
    const verd = `${ev.verdict}/${harness}`;
    console.info(`${tgt} ${h} ${mod} ${icStr} ${ciPadded} ${resStr} ${verd}`);
  }
  console.info("--------------------------------------------------------------------------------------------------------------------\n");

  console.info("HOLM-BONFERRONI GATE ON RESIDUAL IC");
  console.info("--------------------------------------------------------------------------------------");
  for (const gate of result.holmAdjustedVerdict) {
    console.info(
      `${gate.target.padEnd(30)} ${`${gate.horizon}m`.padEnd(6)}`
      + ` p=${gate.pValue.toFixed(4)} adj=${gate.adjustedPValue.toFixed(4)} ${gate.passed ? "PASS" : "FAIL"}`,
    );
  }
  console.info("--------------------------------------------------------------------------------------\n");

  // Print sample decile monotonicity for best target
  const bestEval = [...result.evaluations].sort((a, b) => (b.oofSpearmanIc.ic ?? -1) - (a.oofSpearmanIc.ic ?? -1))[0];
  if (bestEval && bestEval.deciles.length > 0) {
    console.info(`PREDICTION DECILE MONOTONICITY (Best Candidate: ${bestEval.targetName} ${bestEval.horizonMinutes}m)`);
    console.info("--------------------------------------------------------------------------------------");
    console.info("DECILE     COUNT     MEAN PREDICTED SCORE    MEAN REALIZED RETURN (BPS)    HIT RATE (%)");
    console.info("--------------------------------------------------------------------------------------");
    for (const d of bestEval.deciles) {
      const dec = `D${d.decile}`.padEnd(10);
      const cnt = String(d.count).padEnd(9);
      const score = d.meanPredictedScore.toFixed(4).padStart(18).padEnd(23);
      const ret = `${d.meanRealizedReturnBps >= 0 ? "+" : ""}${d.meanRealizedReturnBps.toFixed(2)} bps`.padStart(22).padEnd(29);
      const hr = `${(d.hitRate * 100).toFixed(1)}%`;
      console.info(`${dec} ${cnt} ${score} ${ret} ${hr}`);
    }
    console.info("--------------------------------------------------------------------------------------\n");
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const manifest = {
    protocol: "directional-intelligence-v2-d0-d1",
    estimator: "robust-abs-ewma-v1",
    calendarPolicy: "regular-nse-with-explicit-special-session-exclusions-v1",
    dataQualityPolicy: "drop-entire-session-for-unrepairable-fyers-candle-v1",
    negativeLagPolicy: "diagnostic-for-causal-price-derived-features-v1",
    symbols: options.symbols,
    horizonsMinutes: [15, 30, 60],
    gridIntervalMinutes: 5,
    kMultiplier: options.kMultiplier,
    tripleBarrierMultiplier: 1,
    folds: options.numFolds,
    seed: options.seed,
  } as const;
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  console.info(`Frozen run manifest: ${JSON.stringify(manifest)}`);
  console.info(`Manifest SHA-256: ${manifestHash}`);
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);

  try {
    const d1Results: D1StudyResult[] = [];
    const artifacts: Array<{
      dataset: { instrument: string; sampleCount: number; sessionCount: number; firstSession: string | null; lastSession: string | null };
      d0: D0QualityReport;
      d1: D1StudyResult;
    }> = [];

    for (const symbol of options.symbols) {
      console.info(`\nLoading 1m candles for ${symbol}...`);
      await assertAuditedSeriesProvenance(database, symbol);
      const candles = await loadCandlesForSymbol(database, symbol, options.maxSessions);
      const marketSessions = await loadExpectedSessions(database, candles, symbol);
      const audit = auditDirectionalCandles(symbol, candles, marketSessions, {
        excludedSpecialSessions: phase29ExcludedSpecialSessionMap(),
        excludedDataQualitySessions: phase29DataQualitySessionExclusionMap(symbol),
        excludedCandleOpens: phase29DataQualityCandleExclusionMap(symbol),
      });
      if (!audit.ready) {
        const preview = audit.issues.slice(0, 20).map((issue) => `  - ${issue.message}`).join("\n");
        throw new Error(
          `${symbol} failed the mandatory directional data audit with ${audit.issues.length} issue(s):\n${preview}`
          + (audit.issues.length > 20 ? `\n  ... ${audit.issues.length - 20} more` : ""),
        );
      }
      console.info(`Loaded ${candles.length} candles for ${symbol}. Generating dataset...`);

      const dataset = generateDirectionalDataset(symbol, candles, {
        kMultiplier: options.kMultiplier,
        marketSessions,
      });

      // D0 Report
      const rawRecords = dataset.samples.map((s) => ({
        sampleId: s.sampleId,
        sessionDate: s.sessionDate,
        decisionAt: s.decisionAt,
        minuteOfDay: s.minuteOfDay,
        expectedVolBps: s.volatility.base1mExpectedVolBps,
        adaptive15: s.adaptive15,
        adaptive30: s.adaptive30,
        adaptive60: s.adaptive60,
        tb15: s.tb15,
        tb30: s.tb30,
        tb60: s.tb60,
        moveSide15: s.moveSide15,
        moveSide30: s.moveSide30,
        moveSide60: s.moveSide60,
        pathEff15: s.pathEff15,
        pathEff30: s.pathEff30,
        pathEff60: s.pathEff60,
        continuous15: s.continuous15,
        continuous30: s.continuous30,
        continuous60: s.continuous60,
      }));

      const d0Report = generateD0QualityReport(symbol, rawRecords, dataset.overlapByHorizon, dataset.overlapByTarget);
      printD0Report(d0Report);

      // D1 Study
      console.info(`Executing D1 Learnability Study for ${symbol} (Purged ${options.numFolds}-Fold CV)...`);
      const d1Result = runD1LearnabilityStudy(dataset, candles, {
        numFolds: options.numFolds,
        seed: options.seed,
      });
      printD1Report(d1Result);
      d1Results.push(d1Result);
      artifacts.push({
        dataset: {
          instrument: dataset.instrument,
          sampleCount: dataset.samples.length,
          sessionCount: dataset.sessions.length,
          firstSession: dataset.sessions[0]?.sessionDate ?? null,
          lastSession: dataset.sessions[dataset.sessions.length - 1]?.sessionDate ?? null,
        },
        d0: d0Report,
        d1: d1Result,
      });
    }

    // Cross-Instrument Replication Summary
    if (d1Results.length >= 2) {
      console.info("======================================================================================");
      console.info("PHASE 29 §2.2: CROSS-INSTRUMENT REPLICATION SUMMARY");
      console.info("======================================================================================\n");
      const r1 = d1Results[0]!;
      const r2 = d1Results[1]!;

      console.info(`Comparing ${r1.instrument} vs ${r2.instrument}:`);
      console.info("--------------------------------------------------------------------------------------");
      console.info("TARGET                 HORIZON    " + `${r1.instrument} IC`.padEnd(16) + `${r2.instrument} IC`.padEnd(16) + "REPLICATION VERDICT");
      console.info("--------------------------------------------------------------------------------------");

      for (let i = 0; i < r1.evaluations.length; i += 1) {
        const ev1 = r1.evaluations[i]!;
        const ev2 = r2.evaluations.find((e) => e.targetName === ev1.targetName && e.horizonMinutes === ev1.horizonMinutes);
        const ic1 = ev1.oofSpearmanIc.ic ?? 0;
        const ic2 = ev2?.oofSpearmanIc.ic ?? 0;

        const gate1 = r1.holmAdjustedVerdict.find((gate) => gate.target === ev1.targetName && gate.horizon === ev1.horizonMinutes);
        const gate2 = r2.holmAdjustedVerdict.find((gate) => gate.target === ev1.targetName && gate.horizon === ev1.horizonMinutes);
        const bothPass = gate1?.passed === true
          && gate2?.passed === true
          && ev1.verdict === "PASS"
          && ev2?.verdict === "PASS"
          && ev1.falsificationSuite?.verdict === "PASS"
          && ev2?.falsificationSuite?.verdict === "PASS";
        const sameSign = (ic1 > 0 && ic2 > 0) || (ic1 < 0 && ic2 < 0);
        const repVerdict = bothPass ? "REPLICATES (PASS)" : sameSign ? "WEAK / SPLIT" : "DRIFT (FAIL)";

        const tgt = ev1.targetName.padEnd(22);
        const h = `${ev1.horizonMinutes}m`.padEnd(10);
        const s1 = ic1.toFixed(4).padEnd(16);
        const s2 = ic2.toFixed(4).padEnd(16);
        console.info(`${tgt} ${h} ${s1} ${s2} ${repVerdict}`);
      }
      console.info("--------------------------------------------------------------------------------------\n");
    }

    const outputDir = resolve(options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = resolve(outputDir, `phase29-${manifestHash.slice(0, 12)}-${timestamp}.json`);
    await writeFile(outputPath, JSON.stringify(
      { manifest, manifestHash, generatedAt: new Date().toISOString(), artifacts },
      (_key, value: unknown) => value instanceof Map ? Object.fromEntries(value) : value,
      2,
    ), "utf8");
    console.info(`Research artifact written to ${outputPath}`);
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
