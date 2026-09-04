import { utcDateKey } from "./returns.js";
import type { StockIntelligenceUniverse } from "./universe.js";
import { stockIntelligenceVersions, type StockIntelligenceVersions } from "./versions.js";

/**
 * Week 3–6 work unit. Each pair is eligibility + stored-bar PIT audit + the
 * v0.1 20-feature set, analogue sets, and 6M/12M outcome distributions.
 * Gate 6 immutable snapshots are not written here.
 */
export const replayJobKinds = ["monthly_data_replay", "prediction_replay"] as const;
export type ReplayJobKind = (typeof replayJobKinds)[number];

export const replayJobStatuses = ["RUNNING", "PAUSED", "COMPLETE", "FAILED"] as const;
export type ReplayJobStatus = (typeof replayJobStatuses)[number];

export const replayPairStatuses = [
  "COMPLETE",
  "SKIPPED_INELIGIBLE",
  "INSUFFICIENT_MARKET_DATA",
  "PIT_VIOLATION",
  "FAILED",
] as const;
export type ReplayPairStatus = (typeof replayPairStatuses)[number];

export interface ReplayPair {
  readonly instrumentId: string;
  readonly asOf: string;
}

export interface ReplayJob {
  readonly jobId: string;
  readonly status: ReplayJobStatus;
  readonly jobKind: ReplayJobKind;
  readonly completedPairs: readonly ReplayPair[];
  readonly remainingPairs: readonly ReplayPair[];
  readonly lastCheckpoint: Date | null;
  readonly pipelineVersions: StockIntelligenceVersions;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
}

export interface ReplayPairCensorship {
  readonly eligibilityReason: string;
  readonly pitViolationCount: number;
  readonly marketBarCount: number;
  readonly marketDataCompleteness: number;
  readonly fundamentalCompleteness: number;
  readonly featureCount: number;
  readonly documentCoverage: number;
  readonly analogueEffectiveSampleSize6m: number;
  readonly analogueEffectiveSampleSize12m: number;
  readonly outcomeNUsed6m: number;
  readonly outcomeNUsed12m: number;
  readonly rawProbabilityPositive6m: number | null;
  readonly calibratedProbabilityPositive6m: number | null;
  readonly calibrationSource6m: "regime_fit" | "global_fallback" | "none";
}

export interface ReplayPairResult {
  readonly jobId: string;
  readonly instrumentId: string;
  readonly asOf: string;
  readonly status: ReplayPairStatus;
  readonly eligibilityReason: string;
  readonly pitPassed: boolean;
  readonly marketBarCount: number;
  readonly marketDataCompleteness: number;
  readonly censorship: ReplayPairCensorship;
  readonly pipelineVersions: StockIntelligenceVersions;
}

export interface ReplayJobSummary {
  readonly jobId: string;
  readonly status: ReplayJobStatus;
  readonly nSimulated: number;
  readonly nFullyEvaluated: number;
  readonly nCensored: number;
  readonly censoredPct: number;
  readonly censoredReasons: Readonly<Record<string, number>>;
  readonly nPitPassed: number;
  readonly nPitFailed: number;
  readonly survivorshipLimitation: string;
}

export const REPLAY_EQUITY_UNIVERSES: readonly StockIntelligenceUniverse[] = ["NIFTY50", "NIFTYNXT50"];

export const HISTORICAL_REPLAY_WINDOW_FROM = "2015-01-01";
export const HISTORICAL_REPLAY_WINDOW_TO = "2024-12-31";

export const REPLAY_SURVIVORSHIP_LIMITATION =
  "Current-roster membership is knowable from 2026-09-03. Monthly pairs in 2015–2024 are "
  + "ineligible until a historical index archive is sourced. Market bars are still collected "
  + "and PIT-audited so later gates do not inherit a leaky cutoff.";

export function pairKey(pair: ReplayPair): string {
  return `${pair.instrumentId}|${pair.asOf}`;
}

/**
 * Last UTC calendar instant of each month covering `[from, to]`. 2015-01 through
 * 2024-12 is 120 dates. Month-end is the data_cutoff, not the last NSE session.
 */
export function monthlyMonthEndCutoffs(fromInclusive: Date, toInclusive: Date): Date[] {
  if (Number.isNaN(fromInclusive.getTime()) || Number.isNaN(toInclusive.getTime())) {
    throw new Error("monthlyMonthEndCutoffs requires valid dates.");
  }
  if (fromInclusive.getTime() > toInclusive.getTime()) {
    throw new Error("monthlyMonthEndCutoffs from must be on or before to.");
  }
  const dates: Date[] = [];
  let year = fromInclusive.getUTCFullYear();
  let month = fromInclusive.getUTCMonth();
  const endYear = toInclusive.getUTCFullYear();
  const endMonth = toInclusive.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    dates.push(new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)));
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return dates;
}

export function buildReplayPairs(
  instrumentIds: readonly string[],
  asOfDates: readonly Date[],
): ReplayPair[] {
  const pairs: ReplayPair[] = [];
  for (const instrumentId of instrumentIds) {
    if (!instrumentId.trim()) continue;
    for (const asOf of asOfDates) {
      pairs.push({ instrumentId, asOf: utcDateKey(asOf) });
    }
  }
  return pairs;
}

export function remainingAfterCompleted(
  allPairs: readonly ReplayPair[],
  completed: readonly ReplayPair[],
): ReplayPair[] {
  const done = new Set(completed.map(pairKey));
  return allPairs.filter((pair) => !done.has(pairKey(pair)));
}

export function summarizeReplayResults(
  job: Pick<ReplayJob, "jobId" | "status">,
  results: readonly ReplayPairResult[],
): ReplayJobSummary {
  const censoredReasons: Record<string, number> = {};
  let nFullyEvaluated = 0;
  let nPitPassed = 0;
  let nPitFailed = 0;
  for (const result of results) {
    if (result.pitPassed) nPitPassed += 1;
    else nPitFailed += 1;
    if (result.status === "COMPLETE") {
      nFullyEvaluated += 1;
      continue;
    }
    const reason = result.status === "SKIPPED_INELIGIBLE"
      ? result.eligibilityReason
      : result.status;
    censoredReasons[reason] = (censoredReasons[reason] ?? 0) + 1;
  }
  const nSimulated = results.length;
  const nCensored = nSimulated - nFullyEvaluated;
  return {
    jobId: job.jobId,
    status: job.status,
    nSimulated,
    nFullyEvaluated,
    nCensored,
    censoredPct: nSimulated === 0 ? 0 : nCensored / nSimulated,
    censoredReasons,
    nPitPassed,
    nPitFailed,
    survivorshipLimitation: REPLAY_SURVIVORSHIP_LIMITATION,
  };
}

export function currentReplayVersions(): StockIntelligenceVersions {
  return stockIntelligenceVersions;
}
