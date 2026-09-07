/**
 * Sequence / TCN data-readiness gates (Phase 25, Workstream D + E).
 *
 * Pure functions only. A candidate opens research when every numeric gate in
 * {@link SEQUENCE_READINESS_GATES} passes *and* the underlying series is
 * READY under the Workstream A audit. Bar counts are necessary, not
 * sufficient — overlapping windows are not independent observations, and that
 * caveat is recorded on every report so a later Stage 5 trainer cannot treat
 * a gate pass as a free lunch.
 */

import { canonicalJsonForReportHash, type SeriesState } from "./data-readiness.js";

export const SEQUENCE_READINESS_REPORT_VERSION = "sequence-readiness-v1";

export type SequenceGateVerdict = "PASS" | "FAIL" | "BLOCKED";

/**
 * Instrument semantics become part of the sequence contract and model key.
 * Mixing them invisibly is prohibited by Workstream D1.
 */
export type InstrumentSemantics =
  | "SPOT_INDEX"
  | "ETF_PROXY"
  | "FUTURES_CONTRACT"
  | "EQUITY"
  | "OTHER";

export type SequenceCandidateKind = "tcn-1m" | "tcn-5m" | "tcn-15m";

export interface SequenceGateThresholds {
  minimumBars: number;
  minimumSessions: number;
  /** Maximum fraction of zero-volume bars. Spot indices fail this by design. */
  maximumZeroVolumeFraction: number;
  /** Series must be READY under Workstream A; anything else blocks. */
  requireSeriesReady: true;
  /** Provider lineage that must be the sole source of the series. */
  requiredProvider: string;
  /** Native interval — never a resampled alias of a finer bar. */
  requireNativeInterval: true;
}

/**
 * Provisional engineering gates from Phase 25 Workstream D. Re-estimate from
 * the actual dataset before authorizing training; do not invent tighter ones
 * without a recorded reason.
 */
export const SEQUENCE_READINESS_GATES: Record<SequenceCandidateKind, SequenceGateThresholds> = {
  "tcn-1m": {
    minimumBars: 200_000,
    minimumSessions: 250,
    maximumZeroVolumeFraction: 0.01,
    requireSeriesReady: true,
    requiredProvider: "fyers-api-v3",
    requireNativeInterval: true,
  },
  "tcn-5m": {
    minimumBars: 100_000,
    minimumSessions: 250,
    maximumZeroVolumeFraction: 0.01,
    requireSeriesReady: true,
    requiredProvider: "fyers-api-v3",
    requireNativeInterval: true,
  },
  "tcn-15m": {
    minimumBars: 50_000,
    minimumSessions: 250,
    maximumZeroVolumeFraction: 0.01,
    requireSeriesReady: true,
    requiredProvider: "fyers-api-v3",
    requireNativeInterval: true,
  },
};

export const DEFAULT_SEQUENCE_CONTRACT = {
  /** Scalping sequences do not cross the overnight session boundary by default. */
  sessionBoundaryPolicy: "NO_OVERNIGHT_CROSSING" as const,
  /** Windows are built per instrument/timeframe, never across symbols. */
  windowConstruction: "PER_INSTRUMENT_TIMEFRAME" as const,
  /** Only completed candles available by the cutoff may enter a window. */
  candleCompleteness: "COMPLETED_ONLY" as const,
  /**
   * Overlapping sliding windows inflate bar counts relative to independent
   * samples. Recorded so Stage 5 cannot forget it.
   */
  independenceCaveat:
    "Highly overlapping windows do not create the same number of independent observations as the bar count.",
} as const;

export interface SequenceCandidateMeasurements {
  symbol: string;
  exchange: string;
  instrumentType: string;
  instrumentSemantics: InstrumentSemantics;
  timeframe: "1m" | "5m" | "15m";
  candidate: SequenceCandidateKind;
  /** Sole candle provider for the series, or null when mixed/absent. */
  provider: string | null;
  barCount: number;
  sessionCount: number;
  zeroVolumeFraction: number;
  completeness: number | null;
  seriesState: SeriesState | null;
  /** True when bars were collected at this native interval (not resampled). */
  nativeInterval: boolean;
  firstOpenTime: string | null;
  lastOpenTime: string | null;
}

export interface SequenceGateFinding {
  code: string;
  detail: string;
}

export interface SequenceCandidateAssessment {
  verdict: SequenceGateVerdict;
  findings: SequenceGateFinding[];
  thresholds: SequenceGateThresholds;
  measurements: SequenceCandidateMeasurements;
}

export function candidateKindForTimeframe(timeframe: "1m" | "5m" | "15m"): SequenceCandidateKind {
  if (timeframe === "1m") return "tcn-1m";
  if (timeframe === "5m") return "tcn-5m";
  return "tcn-15m";
}

export function instrumentSemanticsFor(
  instrumentType: string,
  metadataPurpose: string | null | undefined,
): InstrumentSemantics {
  const purpose = (metadataPurpose ?? "").toLowerCase();
  if (purpose.includes("tradable-index-proxy") || purpose.includes("etf-proxy")) {
    return "ETF_PROXY";
  }
  const type = instrumentType.toUpperCase();
  if (type === "INDEX") return "SPOT_INDEX";
  if (type === "ETF") return "ETF_PROXY";
  if (type === "FUTURE" || type === "FUTURES") return "FUTURES_CONTRACT";
  if (type === "EQUITY" || type === "STOCK") return "EQUITY";
  return "OTHER";
}

/**
 * Evaluate one TCN candidate against the Workstream D gate table.
 *
 * FAIL means a numeric gate missed. BLOCKED means the series is not READY (or
 * unmeasured) — research must not open on a DEGRADED/STALE/INVALID series even
 * if the bar count looks large.
 */
export function assessSequenceCandidate(
  measurements: SequenceCandidateMeasurements,
  thresholds: SequenceGateThresholds = SEQUENCE_READINESS_GATES[measurements.candidate],
): SequenceCandidateAssessment {
  const findings: SequenceGateFinding[] = [];

  if (measurements.seriesState !== "READY") {
    findings.push({
      code: "SERIES_NOT_READY",
      detail:
        measurements.seriesState == null
          ? "No Workstream A data-readiness measurement exists for this series."
          : `Series state is ${measurements.seriesState}; TCN research requires READY.`,
    });
  }
  if (measurements.barCount < thresholds.minimumBars) {
    findings.push({
      code: "INSUFFICIENT_BARS",
      detail: `${measurements.barCount} bars is below the ${thresholds.minimumBars} floor.`,
    });
  }
  if (measurements.sessionCount < thresholds.minimumSessions) {
    findings.push({
      code: "INSUFFICIENT_SESSIONS",
      detail: `${measurements.sessionCount} sessions is below the ${thresholds.minimumSessions} floor.`,
    });
  }
  if (measurements.zeroVolumeFraction > thresholds.maximumZeroVolumeFraction) {
    findings.push({
      code: "ZERO_VOLUME",
      detail:
        `Zero-volume fraction ${(measurements.zeroVolumeFraction * 100).toFixed(2)}% exceeds the `
        + `${(thresholds.maximumZeroVolumeFraction * 100).toFixed(0)}% ceiling `
        + `(spot indices fail this by design).`,
    });
  }
  if (measurements.provider !== thresholds.requiredProvider) {
    findings.push({
      code: "PROVIDER_MISMATCH",
      detail:
        measurements.provider == null
          ? "Series has mixed or missing providers; TCN research requires a single lineage."
          : `Provider ${measurements.provider} is not the required ${thresholds.requiredProvider}.`,
    });
  }
  if (!measurements.nativeInterval) {
    findings.push({
      code: "NON_NATIVE_INTERVAL",
      detail: "Bars must be a native provider interval, not a resampled alias.",
    });
  }
  if (measurements.instrumentSemantics === "SPOT_INDEX") {
    findings.push({
      code: "SPOT_INDEX_SEMANTICS",
      detail:
        "Spot-index semantics are rejected for volume-dependent TCN research; use an ETF proxy or futures lineage.",
    });
  }

  let verdict: SequenceGateVerdict;
  if (findings.some((f) => f.code === "SERIES_NOT_READY")) {
    verdict = "BLOCKED";
  } else if (findings.length > 0) {
    verdict = "FAIL";
  } else {
    verdict = "PASS";
  }

  return { verdict, findings, thresholds, measurements };
}

export { canonicalJsonForReportHash };
