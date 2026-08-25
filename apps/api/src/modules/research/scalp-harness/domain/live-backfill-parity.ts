import { createHash } from "node:crypto";

/**
 * LIVE_BACKFILL_FEATURE_PARITY_V1 — an acceptance test for the feature-coverage gate.
 *
 * Not a backtest, and deliberately named so it cannot drift into being read as one. The question is
 * exactly one thing:
 *
 *   For every sample the live harness marked eligible, did it consume the same input state that an
 *   after-the-fact reconstruction of the completed session sees?
 *
 * That is the property `candle_feature_coverage` plus minute deferral is supposed to guarantee, and
 * before the gate it was measurably false: on 2026-08-24 the live cohort under-read patterns on 46%
 * of evaluations while the next-day backfilled cohort under-read on 0 of 473 rows.
 *
 * ## The comparison stops before outcomes, structurally
 *
 * No label, forward path, settlement, return or P&L field appears anywhere in this module, and the
 * caller is expected to read no settlement table. A parity run that compared live P&L against
 * backfill P&L would be looking at outcomes again, which is the failure mode this whole diagnostic
 * exists to avoid. Coverage stamping proving "some computation ran" is *not* the same claim as "the
 * exact information consumed live was complete and stable", and only the second one is tested here.
 */
export const LIVE_BACKFILL_PARITY_VERSION = "LIVE_BACKFILL_FEATURE_PARITY_V1";

/** The 1m indicators the research strategies read, compared individually so a diff names one. */
export const PARITY_COMPARED_INDICATORS = ["ATR", "EMA:3", "EMA:8", "RSI", "VWAP", "SUPERTREND"] as const;

export interface ParityIndicator {
  readonly code: string;
  readonly algorithmVersion: string;
  readonly parameters: Record<string, unknown>;
  readonly values: Record<string, unknown>;
}

export interface ParityPattern {
  readonly code: string;
  readonly algorithmVersion: string;
  readonly direction: string;
  readonly confidence: number;
}

export interface ParityPriceActionEvent {
  readonly eventCode: string;
  readonly algorithmVersion: string;
  readonly direction: string;
  readonly level: number | null;
  readonly confidence: number;
}

/**
 * Everything a decision was allowed to consume, and nothing it produced downstream.
 *
 * `proposalDirections` is the one derived field, kept because proposal-yes/no is the only parity
 * signal available on a bar that produced no proposal at all -- those bars store no feature vector,
 * so a raw_context comparison is impossible for them and their absence would otherwise be invisible.
 */
export interface ParityConsumedState {
  readonly sampleEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly indicators: readonly ParityIndicator[];
  readonly patterns: readonly ParityPattern[];
  readonly priceActionEvents: readonly ParityPriceActionEvent[];
  readonly nativeConfidenceByStrategy: Readonly<Record<string, number | null>>;
  readonly legacyScoreGateByStrategy: Readonly<Record<string, unknown>>;
  readonly proposalDirections: Readonly<Record<string, string>>;
}

export type ParityField =
  | "sampleEligible"
  | "ineligibleReason"
  | "indicator"
  | "patternSet"
  | "priceActionSet"
  | "nativeConfidence"
  | "legacyScoreGate"
  | "proposalPresence"
  | "proposalDirection"
  | "coverageOrdering";

export interface ParityMismatch {
  readonly field: ParityField;
  readonly detail: string;
  readonly live: string;
  readonly reconstructed: string;
}

export interface ParitySampleResult {
  readonly sessionDate: string;
  readonly instrumentSymbol: string;
  readonly decisionAt: string;
  readonly comparable: boolean;
  readonly mismatches: readonly ParityMismatch[];
}

/**
 * Canonical hash of an event set, so ordering never registers as a difference.
 *
 * The repository orders by code then algorithm version, but that ordering is an implementation
 * detail of one query; comparing arrays positionally would turn a harmless reorder into a false
 * parity failure and bury the real ones.
 */
export function canonicalEventSetHash(entries: readonly Record<string, unknown>[]): string {
  const canonical = entries.map((entry) => canonicalJson(entry)).sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Serialises a value with object keys sorted, recursively.
 *
 * `JSON.stringify` preserves insertion order, and the two sides of this comparison build their
 * objects by different routes: the live side reloads a row that Postgres serialised, while the
 * reconstruction builds the object literal in source order. Comparing the raw strings therefore
 * reports a difference whenever the key order differs, even though every value is identical.
 *
 * Measured on 2026-08-25 that was not a nuisance but the dominant signal: **483 of 748 reported
 * mismatches were pure key-order artefacts**, which pushed the run to NO_PARITY and buried the 265
 * genuine ones. An acceptance test whose false positives outnumber its findings two to one is worse
 * than no acceptance test, because it gets read as evidence.
 *
 * Arrays keep their order here -- element order can be meaningful. Sets whose order is an
 * implementation detail go through `canonicalEventSetHash`, which sorts them explicitly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function indicatorKey(indicator: ParityIndicator): string {
  // EMA is the one indicator read at two periods, so the period distinguishes them; every other
  // code appears once and its parameters are already pinned by the eligibility rule.
  const period = indicator.parameters.period;
  return indicator.code === "EMA" && typeof period === "number" ? `EMA:${period}` : indicator.code;
}

/**
 * Numeric equality for values that were stored, reloaded and JSON round-tripped.
 *
 * A relative epsilon rather than exact equality, because both sides pass through JSON and a
 * last-bit difference is not evidence of a race. It is deliberately tiny: the mutation this looks
 * for -- a feature layer recomputed after capture -- moves values far more than this.
 */
function numericallyEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isNaN(left) && Number.isNaN(right)) return true;
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= 1e-9 * scale;
  }
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

/**
 * Compares one sample's consumed state.
 *
 * Only runs when live capture marked the sample eligible: the acceptance condition is scoped to
 * eligible samples, because an ineligible one is by definition a decision the harness declined to
 * treat as a usable observation.
 */
export function compareConsumedState(
  live: ParityConsumedState,
  reconstructed: ParityConsumedState,
  options: {
    /**
     * Whether both sides actually carry a feature vector.
     *
     * False when either side produced no proposal, because `raw_context` exists only on proposals:
     * the absent side then has empty indicator and event arrays, and comparing them would report
     * six indicator mismatches, a pattern-set mismatch and two gate mismatches for what is really
     * one fact -- that one side did not propose. That inflation would read as an indicator race and
     * bury the single mismatch that matters, so the presence check stands alone in that case.
     */
    compareFeatureVectors: boolean;
  } = { compareFeatureVectors: true },
): ParityMismatch[] {
  const mismatches: ParityMismatch[] = [];

  if (live.sampleEligible !== reconstructed.sampleEligible) {
    mismatches.push({
      field: "sampleEligible",
      detail: "eligibility differs between live capture and reconstruction",
      live: String(live.sampleEligible),
      reconstructed: String(reconstructed.sampleEligible),
    });
  }
  if ((live.ineligibleReason ?? null) !== (reconstructed.ineligibleReason ?? null)) {
    mismatches.push({
      field: "ineligibleReason",
      detail: "eligibility reason differs",
      live: live.ineligibleReason ?? "(null)",
      reconstructed: reconstructed.ineligibleReason ?? "(null)",
    });
  }

  if (!options.compareFeatureVectors) {
    // Proposal presence is still fully comparable, and it is the signal that catches a silent
    // under-read on a bar that stored no feature vector.
    return [...mismatches, ...compareProposalPresence(live, reconstructed)];
  }

  const liveIndicators = new Map(live.indicators.map((item) => [indicatorKey(item), item]));
  const rebuiltIndicators = new Map(reconstructed.indicators.map((item) => [indicatorKey(item), item]));
  for (const key of PARITY_COMPARED_INDICATORS) {
    const liveValue = liveIndicators.get(key);
    const rebuiltValue = rebuiltIndicators.get(key);
    if (!liveValue && !rebuiltValue) continue;
    if (!liveValue || !rebuiltValue) {
      mismatches.push({
        field: "indicator",
        detail: `${key} present on only one side`,
        live: liveValue ? "present" : "absent",
        reconstructed: rebuiltValue ? "present" : "absent",
      });
      continue;
    }
    if (liveValue.algorithmVersion !== rebuiltValue.algorithmVersion) {
      mismatches.push({
        field: "indicator",
        detail: `${key} algorithm version differs`,
        live: liveValue.algorithmVersion,
        reconstructed: rebuiltValue.algorithmVersion,
      });
      continue;
    }
    const keys = new Set([...Object.keys(liveValue.values), ...Object.keys(rebuiltValue.values)]);
    for (const valueKey of keys) {
      if (!numericallyEqual(liveValue.values[valueKey], rebuiltValue.values[valueKey])) {
        mismatches.push({
          field: "indicator",
          detail: `${key}.${valueKey} differs`,
          live: canonicalJson(liveValue.values[valueKey] ?? null),
          reconstructed: canonicalJson(rebuiltValue.values[valueKey] ?? null),
        });
      }
    }
  }

  const livePatterns = canonicalEventSetHash(live.patterns as unknown as Record<string, unknown>[]);
  const rebuiltPatterns = canonicalEventSetHash(reconstructed.patterns as unknown as Record<string, unknown>[]);
  if (livePatterns !== rebuiltPatterns) {
    mismatches.push({
      field: "patternSet",
      detail: `candlestick pattern set differs (${live.patterns.length} live vs ${reconstructed.patterns.length} reconstructed)`,
      live: livePatterns.slice(0, 16),
      reconstructed: rebuiltPatterns.slice(0, 16),
    });
  }

  const livePae = canonicalEventSetHash(live.priceActionEvents as unknown as Record<string, unknown>[]);
  const rebuiltPae = canonicalEventSetHash(reconstructed.priceActionEvents as unknown as Record<string, unknown>[]);
  if (livePae !== rebuiltPae) {
    mismatches.push({
      field: "priceActionSet",
      detail: `price-action event set differs (${live.priceActionEvents.length} live vs ${reconstructed.priceActionEvents.length} reconstructed)`,
      live: livePae.slice(0, 16),
      reconstructed: rebuiltPae.slice(0, 16),
    });
  }

  const strategies = new Set([
    ...Object.keys(live.nativeConfidenceByStrategy),
    ...Object.keys(reconstructed.nativeConfidenceByStrategy),
  ]);
  for (const strategy of strategies) {
    const liveValue = live.nativeConfidenceByStrategy[strategy] ?? null;
    const rebuiltValue = reconstructed.nativeConfidenceByStrategy[strategy] ?? null;
    if (!numericallyEqual(liveValue, rebuiltValue)) {
      mismatches.push({
        field: "nativeConfidence",
        detail: `${strategy} native confidence differs`,
        live: String(liveValue),
        reconstructed: String(rebuiltValue),
      });
    }
  }

  const gateStrategies = new Set([
    ...Object.keys(live.legacyScoreGateByStrategy),
    ...Object.keys(reconstructed.legacyScoreGateByStrategy),
  ]);
  for (const strategy of gateStrategies) {
    const liveGate = canonicalJson(live.legacyScoreGateByStrategy[strategy] ?? null);
    const rebuiltGate = canonicalJson(reconstructed.legacyScoreGateByStrategy[strategy] ?? null);
    if (liveGate !== rebuiltGate) {
      mismatches.push({
        field: "legacyScoreGate",
        detail: `${strategy} legacy score gate differs`,
        live: liveGate,
        reconstructed: rebuiltGate,
      });
    }
  }

  return [...mismatches, ...compareProposalPresence(live, reconstructed)];
}

function compareProposalPresence(
  live: ParityConsumedState,
  reconstructed: ParityConsumedState,
): ParityMismatch[] {
  const mismatches: ParityMismatch[] = [];
  const proposalKeys = new Set([
    ...Object.keys(live.proposalDirections),
    ...Object.keys(reconstructed.proposalDirections),
  ]);
  for (const key of proposalKeys) {
    const liveDirection = live.proposalDirections[key];
    const rebuiltDirection = reconstructed.proposalDirections[key];
    if (liveDirection === undefined || rebuiltDirection === undefined) {
      mismatches.push({
        field: "proposalPresence",
        detail: `${key} proposed on only one side`,
        live: liveDirection ?? "(none)",
        reconstructed: rebuiltDirection ?? "(none)",
      });
      continue;
    }
    if (liveDirection !== rebuiltDirection) {
      mismatches.push({
        field: "proposalDirection",
        detail: `${key} direction differs`,
        live: liveDirection,
        reconstructed: rebuiltDirection,
      });
    }
  }
  return mismatches;
}

export interface CoverageTiming {
  readonly decisionAt: Date;
  readonly coverageSatisfiedAt: Date | null;
  readonly sampleCapturedAt: Date;
}

export interface CoverageOrderingResult {
  readonly coverageLagMs: number | null;
  readonly mismatch: ParityMismatch | null;
}

/**
 * Asserts the ordering the gate exists to create: features complete **before** the sample is taken.
 *
 * Coverage existing is a weaker claim than coverage preceding capture, and only the second one rules
 * out the race. A row stamped after its own sample was captured is a coverage row that arrived too
 * late to have protected anything, which reads as compliance while being exactly the defect.
 *
 * A null `coverageSatisfiedAt` on an eligible sample is itself a failure: the gate should not have
 * admitted it.
 */
export function checkCoverageOrdering(timing: CoverageTiming): CoverageOrderingResult {
  if (timing.coverageSatisfiedAt === null) {
    return {
      coverageLagMs: null,
      mismatch: {
        field: "coverageOrdering",
        detail: "eligible sample has no coverage timestamp",
        live: timing.sampleCapturedAt.toISOString(),
        reconstructed: "(no coverage row)",
      },
    };
  }
  const coverageLagMs = timing.sampleCapturedAt.getTime() - timing.coverageSatisfiedAt.getTime();
  if (coverageLagMs < 0) {
    return {
      coverageLagMs,
      mismatch: {
        field: "coverageOrdering",
        detail: "coverage was stamped after the sample was captured",
        live: `captured ${timing.sampleCapturedAt.toISOString()}`,
        reconstructed: `covered ${timing.coverageSatisfiedAt.toISOString()}`,
      },
    };
  }
  return { coverageLagMs, mismatch: null };
}

export interface ParityReport {
  readonly version: string;
  readonly sessionDate: string;
  readonly eligibleSampleCount: number;
  readonly comparableSampleCount: number;
  readonly mismatchCountsByField: Readonly<Record<string, number>>;
  readonly coverageLagMs: { readonly min: number; readonly median: number; readonly max: number } | null;
  readonly passed: boolean;
  readonly samples: readonly ParitySampleResult[];
}

/**
 * Rolls sample results into the acceptance verdict.
 *
 * Fails on zero comparable samples as well as on any mismatch: a parity run that compared nothing
 * proves nothing, and a vacuous pass on an acceptance test is worse than a failure because it is
 * mistaken for evidence.
 */
export function summariseParity(input: {
  sessionDate: string;
  samples: readonly ParitySampleResult[];
  coverageLags: readonly number[];
}): ParityReport {
  const comparable = input.samples.filter((sample) => sample.comparable);
  const mismatchCountsByField: Record<string, number> = {};
  for (const sample of input.samples) {
    for (const mismatch of sample.mismatches) {
      mismatchCountsByField[mismatch.field] = (mismatchCountsByField[mismatch.field] ?? 0) + 1;
    }
  }
  const lags = [...input.coverageLags].sort((left, right) => left - right);
  return {
    version: LIVE_BACKFILL_PARITY_VERSION,
    sessionDate: input.sessionDate,
    eligibleSampleCount: input.samples.length,
    comparableSampleCount: comparable.length,
    mismatchCountsByField,
    coverageLagMs: lags.length === 0 ? null : {
      min: lags[0]!,
      median: lags[Math.floor(lags.length / 2)]!,
      max: lags[lags.length - 1]!,
    },
    passed: comparable.length > 0 && Object.keys(mismatchCountsByField).length === 0,
    samples: input.samples,
  };
}
