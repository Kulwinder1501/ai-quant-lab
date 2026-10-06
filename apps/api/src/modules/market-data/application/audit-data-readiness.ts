import { createHash } from "node:crypto";
import type {
  IndicatorCoverageRow,
  InstitutionalFlowContext,
  PostgresDataReadinessRepository,
  SeriesAggregateRow,
  SeriesSessionRow,
} from "../../../infrastructure/database/repositories/postgres-data-readiness-repository.js";
import {
  DATA_READINESS_REPORT_VERSION,
  DATA_READINESS_THRESHOLDS,
  REQUIRED_INDICATOR_CODES,
  assessSeries,
  canonicalJsonForReportHash,
  longestSessionGapWeekdays,
  modalValue,
  weekdaysBetween,
  type SeriesMeasurements,
  type SeriesState,
} from "../domain/data-readiness.js";

export const PRODUCTION_INDICATOR_ALGORITHM_VERSION = "ta-v1";

export interface SeriesReportEntry extends SeriesMeasurements {
  state: SeriesState;
  reasons: string[];
}

export interface DataReadinessReport {
  version: string;
  generatedAt: string;
  thresholds: typeof DATA_READINESS_THRESHOLDS;
  requiredIndicators: readonly string[];
  series: SeriesReportEntry[];
  instrumentsWithoutBars: string[];
  context: {
    institutionalFlows: InstitutionalFlowContext & { ageWeekdays: number | null };
  };
  summary: Record<SeriesState, number>;
}

export interface AuditDataReadinessResult {
  reportId: string;
  reportHash: string;
  createdAt: string;
  report: DataReadinessReport;
}

/** IST calendar date of a moment, as YYYY-MM-DD. Sessions are IST concepts. */
function istDateKey(moment: Date): string {
  return new Date(moment.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Phase 25 Workstream A: one reproducible, machine-readable data-health report.
 *
 * Runnable without training a model; persisted so a training run can record the
 * exact audit it ran under. The assessment rules live in the domain module —
 * this class only assembles measurements, assigns states through them, and
 * hashes the result.
 */
export class AuditDataReadiness {
  constructor(private readonly repository: PostgresDataReadinessRepository) {}

  async execute(now: Date = new Date()): Promise<AuditDataReadinessResult> {
    const [aggregates, sessions, coverage, withoutBars, flows] = await Promise.all([
      this.repository.listSeriesAggregates(),
      this.repository.listSessionCounts(),
      this.repository.listIndicatorCoverage(PRODUCTION_INDICATOR_ALGORITHM_VERSION),
      this.repository.listInstrumentsWithoutBars(),
      this.repository.institutionalFlowContext(),
    ]);

    const sessionsBySeries = groupSessions(sessions);
    const coverageBySeries = groupCoverage(coverage);
    const todayIst = istDateKey(now);

    const series: SeriesReportEntry[] = aggregates.map((aggregate) => {
      const key = `${aggregate.symbol}|${aggregate.timeframe}`;
      const seriesSessions = sessionsBySeries.get(key) ?? [];
      const sessionDates = seriesSessions.map((session) => session.sessionDate);
      const barsPerSession = seriesSessions.map((session) => session.bars);

      // 1d has one bar per session by definition; a modal-bars completeness
      // ratio would always be exactly 1 and measure nothing. Gap and age
      // checks carry the coverage question for daily series.
      const isDaily = aggregate.timeframe === "1d";
      const modal = isDaily ? null : modalValue(barsPerSession);
      const completeness = modal === null || modal <= 0 || sessionDates.length === 0
        ? null
        : Math.min(1, aggregate.barCount / (modal * sessionDates.length));

      const lastSessionDate = sessionDates[sessionDates.length - 1] ?? todayIst;

      const warmupAllowance = DATA_READINESS_THRESHOLDS.indicatorCoverageWarmupBars;
      const coverageDenominator = Math.max(1, aggregate.barCount - warmupAllowance);
      const coveredByCode = coverageBySeries.get(key) ?? new Map<string, number>();
      const indicatorCoverage: Record<string, number> = {};
      for (const [code, coveredBars] of coveredByCode) {
        indicatorCoverage[code] = Math.min(1, coveredBars / coverageDenominator);
      }
      for (const code of REQUIRED_INDICATOR_CODES) {
        indicatorCoverage[code] = indicatorCoverage[code] ?? 0;
      }

      const measurements: SeriesMeasurements = {
        symbol: aggregate.symbol,
        exchange: aggregate.exchange,
        instrumentType: aggregate.instrumentType,
        isActive: aggregate.isActive,
        timeframe: aggregate.timeframe,
        providers: aggregate.sources,
        barCount: aggregate.barCount,
        provisionalBars: aggregate.provisionalBars,
        expiredProvisionalBars: aggregate.expiredProvisionalBars,
        duplicateOpenTimes: aggregate.duplicateOpenTimes,
        invalidOhlcBars: aggregate.invalidOhlcBars,
        negativeVolumeBars: aggregate.negativeVolumeBars,
        firstOpenTime: aggregate.firstOpenTime.toISOString(),
        lastOpenTime: aggregate.lastOpenTime.toISOString(),
        lastCloseTime: aggregate.lastCloseTime.toISOString(),
        sessionCount: sessionDates.length,
        modalBarsPerSession: modal,
        completeness,
        longestGapWeekdays: longestSessionGapWeekdays(sessionDates),
        ageWeekdays: weekdaysBetween(lastSessionDate, todayIst),
        zeroVolumeFraction: aggregate.barCount === 0 ? 0 : aggregate.zeroVolumeBars / aggregate.barCount,
        medianVolume: aggregate.medianVolume,
        indicatorCoverage,
      };

      const assessment = assessSeries(measurements);
      return { ...measurements, state: assessment.state, reasons: assessment.reasons };
    });

    const summary: Record<SeriesState, number> = { READY: 0, DEGRADED: 0, STALE: 0, INVALID: 0 };
    for (const entry of series) summary[entry.state] += 1;

    const flowAgeWeekdays = flows.lastDate === null ? null : weekdaysBetween(flows.lastDate, todayIst);

    const report: DataReadinessReport = {
      version: DATA_READINESS_REPORT_VERSION,
      generatedAt: now.toISOString(),
      thresholds: DATA_READINESS_THRESHOLDS,
      requiredIndicators: REQUIRED_INDICATOR_CODES,
      series,
      instrumentsWithoutBars: withoutBars,
      context: {
        institutionalFlows: { ...flows, ageWeekdays: flowAgeWeekdays },
      },
      summary,
    };

    const reportHash = createHash("sha256").update(canonicalJsonForReportHash(report)).digest("hex");
    const persisted = await this.repository.saveReport(reportHash, report);
    return { reportId: persisted.id, reportHash, createdAt: persisted.createdAt, report };
  }
}

function groupSessions(rows: SeriesSessionRow[]): Map<string, SeriesSessionRow[]> {
  const grouped = new Map<string, SeriesSessionRow[]>();
  for (const row of rows) {
    const key = `${row.symbol}|${row.timeframe}`;
    const existing = grouped.get(key);
    if (existing) existing.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function groupCoverage(rows: IndicatorCoverageRow[]): Map<string, Map<string, number>> {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = `${row.symbol}|${row.timeframe}`;
    const existing = grouped.get(key) ?? new Map<string, number>();
    existing.set(row.indicatorCode, row.coveredBars);
    grouped.set(key, existing);
  }
  return grouped;
}
