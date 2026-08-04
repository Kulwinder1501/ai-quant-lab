import { createHash } from "node:crypto";
import type { PostgresSequenceReadinessRepository } from "../../../infrastructure/database/repositories/postgres-sequence-readiness-repository.js";
import {
  DEFAULT_SEQUENCE_CONTRACT,
  SEQUENCE_READINESS_GATES,
  SEQUENCE_READINESS_REPORT_VERSION,
  assessSequenceCandidate,
  candidateKindForTimeframe,
  canonicalJson,
  instrumentSemanticsFor,
  type SequenceCandidateAssessment,
  type SequenceCandidateKind,
  type SequenceGateVerdict,
} from "../domain/sequence-readiness.js";

/** Default research roster for Stage 4: the D1 ETF proxy plus the spot index as a negative control. */
export const DEFAULT_SEQUENCE_CANDIDATE_SYMBOLS = ["NIFTYBEES", "NIFTY50"] as const;
export const DEFAULT_SEQUENCE_CANDIDATE_TIMEFRAMES = ["1m", "5m"] as const;

export interface SequenceReadinessReport {
  version: string;
  generatedAt: string;
  contract: typeof DEFAULT_SEQUENCE_CONTRACT;
  gates: typeof SEQUENCE_READINESS_GATES;
  candidates: SequenceCandidateAssessment[];
  summary: Record<SequenceGateVerdict, number>;
  /**
   * True when at least one candidate PASSed. Stage 5 may open research only
   * for those specific PASSed candidates, not for the whole report.
   */
  anyResearchAuthorized: boolean;
}

export interface AuditSequenceReadinessResult {
  reportId: string;
  reportHash: string;
  createdAt: string;
  report: SequenceReadinessReport;
}

export interface AuditSequenceReadinessInput {
  symbols?: readonly string[];
  timeframes?: readonly ("1m" | "5m" | "15m")[];
}

/**
 * Phase 25 Workstream D/E: evaluate TCN sequence-readiness gates.
 *
 * Depends on a fresh Workstream A data-readiness report already being in the
 * database — series state is read from that report so the two audits cannot
 * disagree about READY/DEGRADED. Persists a hashed report for Stage 5 to cite.
 */
export class AuditSequenceReadiness {
  constructor(private readonly repository: PostgresSequenceReadinessRepository) {}

  async execute(
    input: AuditSequenceReadinessInput = {},
    now: Date = new Date(),
  ): Promise<AuditSequenceReadinessResult> {
    const symbols = [...(input.symbols ?? DEFAULT_SEQUENCE_CANDIDATE_SYMBOLS)];
    const timeframes = [...(input.timeframes ?? DEFAULT_SEQUENCE_CANDIDATE_TIMEFRAMES)];
    const rows = await this.repository.listCandidateSeries(symbols, timeframes);

    const candidates: SequenceCandidateAssessment[] = rows.map((row) => {
      const timeframe = row.timeframe as "1m" | "5m" | "15m";
      const candidate = candidateKindForTimeframe(timeframe);
      const provider = row.sources.length === 1 ? row.sources[0]! : null;
      return assessSequenceCandidate({
        symbol: row.symbol,
        exchange: row.exchange,
        instrumentType: row.instrumentType,
        instrumentSemantics: instrumentSemanticsFor(row.instrumentType, row.metadataPurpose),
        timeframe,
        candidate,
        provider,
        barCount: row.barCount,
        sessionCount: row.sessionCount,
        zeroVolumeFraction: row.zeroVolumeFraction,
        completeness: row.completeness,
        seriesState: row.seriesState,
        // Fyers/Yahoo historical collection always uses native intervals in this
        // codebase; resampling is forbidden by Workstream D2 and has no path.
        nativeInterval: true,
        firstOpenTime: row.firstOpenTime,
        lastOpenTime: row.lastOpenTime,
      });
    });

    // Surface requested candidates that the A-audit never measured.
    const measured = new Set(candidates.map((c) => `${c.measurements.symbol}|${c.measurements.timeframe}`));
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const key = `${symbol.toUpperCase()}|${timeframe}`;
        if (measured.has(key)) continue;
        const candidate = candidateKindForTimeframe(timeframe);
        candidates.push(
          assessSequenceCandidate({
            symbol: symbol.toUpperCase(),
            exchange: "NSE",
            instrumentType: "UNKNOWN",
            instrumentSemantics: "OTHER",
            timeframe,
            candidate,
            provider: null,
            barCount: 0,
            sessionCount: 0,
            zeroVolumeFraction: 1,
            completeness: null,
            seriesState: null,
            nativeInterval: true,
            firstOpenTime: null,
            lastOpenTime: null,
          }),
        );
      }
    }

    candidates.sort((a, b) => {
      const left = `${a.measurements.symbol}|${a.measurements.timeframe}`;
      const right = `${b.measurements.symbol}|${b.measurements.timeframe}`;
      return left.localeCompare(right);
    });

    const summary: Record<SequenceGateVerdict, number> = { PASS: 0, FAIL: 0, BLOCKED: 0 };
    for (const candidate of candidates) {
      summary[candidate.verdict] += 1;
    }

    const report: SequenceReadinessReport = {
      version: SEQUENCE_READINESS_REPORT_VERSION,
      generatedAt: now.toISOString(),
      contract: DEFAULT_SEQUENCE_CONTRACT,
      gates: SEQUENCE_READINESS_GATES,
      candidates,
      summary,
      anyResearchAuthorized: summary.PASS > 0,
    };

    const reportHash = createHash("sha256").update(canonicalJson(report)).digest("hex");
    const saved = await this.repository.saveReport(reportHash, report);
    return {
      reportId: saved.id,
      reportHash,
      createdAt: saved.createdAt,
      report,
    };
  }
}

export type { SequenceCandidateKind };
