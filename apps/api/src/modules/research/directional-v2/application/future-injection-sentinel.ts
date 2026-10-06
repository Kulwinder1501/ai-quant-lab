import {
  generateDirectionalDataset,
  type DatasetGeneratorOptions,
  type DirectionalSample,
} from "./generate-directional-dataset.js";
import type { SessionCandle } from "../domain/session-calendar.js";

/**
 * Detects look-ahead by corrupting the future and checking that the past did not move.
 *
 * A no-lookahead feature is a function of bars at or before its `dataThrough`. So if every bar after
 * a cut is replaced with obvious nonsense and a sample whose `dataThrough` precedes the cut still
 * produces a different feature vector, some code path read past the boundary. That is a proof of
 * leakage, not a heuristic: the two runs differ only in data the sample was not entitled to see.
 *
 * ## Only features are compared, never labels
 *
 * `DirectionalSample` carries both, and a label is *defined* by future bars -- `forwardPath`,
 * `adaptive30`, `tb60` and friends must change when the future changes. Comparing whole samples
 * would therefore fire on every row and detect nothing. The comparison set below is the feature
 * side, and it is an explicit allowlist rather than a denylist: a new feature field is silently
 * unprotected under a denylist, which is the failure mode that matters here.
 */
export const SENTINEL_COMPARED_FEATURES = [
  "minuteOfDay",
  "timeToSessionCloseMinutes",
  "referencePrice",
  "volatility",
] as const;

export interface FutureInjectionFinding {
  readonly sampleId: string;
  readonly sessionDate: string;
  readonly field: string;
  readonly baseline: string;
  readonly corrupted: string;
}

export interface FutureInjectionReport {
  readonly cutAt: Date;
  /** Samples entitled to see only pre-cut data, i.e. the ones that must be unchanged. */
  readonly protectedSampleCount: number;
  readonly corruptedCandleCount: number;
  readonly findings: readonly FutureInjectionFinding[];
  readonly leaked: boolean;
}

/**
 * Replaces a bar with a wildly displaced but still well-formed one.
 *
 * Kept OHLC-valid on purpose. An invalid bar would make the generator throw, and a throw is not a
 * leakage signal -- it would mask the very difference the sentinel is looking for.
 */
function corruptCandle(candle: SessionCandle): SessionCandle {
  const scale = 5;
  const open = candle.open * scale;
  const close = candle.close * scale;
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open,
    close,
    high: Math.max(open, close, candle.high * scale),
    low: Math.min(open, close, candle.low * scale),
    volume: candle.volume * scale,
  };
}

function featureFingerprint(sample: DirectionalSample): Map<string, string> {
  const fingerprint = new Map<string, string>();
  for (const field of SENTINEL_COMPARED_FEATURES) {
    // JSON rather than `String`, so a nested volatility context is compared structurally instead of
    // collapsing to "[object Object]" and passing trivially.
    fingerprint.set(field, JSON.stringify(sample[field] ?? null));
  }
  return fingerprint;
}

/**
 * Runs one cut. Samples with `dataThrough` at or before `cutAt` must be feature-identical.
 *
 * The boundary is inclusive of `dataThrough === cutAt` because `dataThrough` is already the last
 * instant a sample may observe; a bar opening exactly at the cut is future data to it.
 */
export function detectFutureInjection(input: {
  instrument: string;
  candles: readonly SessionCandle[];
  cutAt: Date;
  options?: DatasetGeneratorOptions;
  /**
   * Injectable so the detector itself can be shown to fail.
   *
   * A leakage gate that has only ever been observed passing is indistinguishable from one that
   * cannot fail at all, and this one guards a frozen experiment. Production always uses the default.
   */
  generate?: typeof generateDirectionalDataset;
}): FutureInjectionReport {
  const { instrument, candles, cutAt, options } = input;
  const generate = input.generate ?? generateDirectionalDataset;
  if (Number.isNaN(cutAt.getTime())) throw new Error("Future-injection sentinel requires a valid cut timestamp.");

  const corruptedCandles = candles.map((candle) => (
    candle.openTime.getTime() >= cutAt.getTime() ? corruptCandle(candle) : candle
  ));
  const corruptedCandleCount = corruptedCandles.filter((candle, index) => candle !== candles[index]).length;
  if (corruptedCandleCount === 0) {
    throw new Error("Future-injection sentinel corrupted no candles; the cut is at or after the last bar.");
  }

  const baseline = generate(instrument, candles, options);
  const corrupted = generate(instrument, corruptedCandles, options);
  const corruptedById = new Map(corrupted.samples.map((sample) => [sample.sampleId, sample]));

  const findings: FutureInjectionFinding[] = [];
  let protectedSampleCount = 0;
  for (const sample of baseline.samples) {
    if (sample.dataThrough.getTime() > cutAt.getTime()) continue;
    protectedSampleCount += 1;
    const other = corruptedById.get(sample.sampleId);
    if (!other) {
      // The sample disappearing is itself leakage: whether a pre-cut decision point exists cannot
      // depend on what happened afterwards.
      findings.push({
        sampleId: sample.sampleId,
        sessionDate: sample.sessionDate,
        field: "(sample missing)",
        baseline: "present",
        corrupted: "absent",
      });
      continue;
    }
    const before = featureFingerprint(sample);
    const after = featureFingerprint(other);
    for (const [field, value] of before) {
      const otherValue = after.get(field);
      if (otherValue !== value) {
        findings.push({
          sampleId: sample.sampleId,
          sessionDate: sample.sessionDate,
          field,
          baseline: value,
          corrupted: otherValue ?? "(absent)",
        });
      }
    }
  }

  return {
    cutAt,
    protectedSampleCount,
    corruptedCandleCount,
    findings,
    leaked: findings.length > 0,
  };
}

/**
 * Throws on any leakage, for use as a gate rather than a report.
 *
 * Deliberately fails on `protectedSampleCount === 0` too: a cut that protects nothing proves
 * nothing, and a silently vacuous pass is the way a leakage gate stops working without anyone
 * noticing.
 */
export function assertNoFutureInjection(input: {
  instrument: string;
  candles: readonly SessionCandle[];
  cutAt: Date;
  options?: DatasetGeneratorOptions;
  generate?: typeof generateDirectionalDataset;
}): FutureInjectionReport {
  const report = detectFutureInjection(input);
  if (report.protectedSampleCount === 0) {
    throw new Error(`Future-injection sentinel protected no samples at ${input.cutAt.toISOString()}; the check was vacuous.`);
  }
  if (report.leaked) {
    const detail = report.findings.slice(0, 5)
      .map((finding) => `${finding.sampleId}.${finding.field}: ${finding.baseline} -> ${finding.corrupted}`)
      .join("; ");
    throw new Error(
      `FUTURE_INJECTION_DETECTED: ${report.findings.length} pre-cut feature(s) changed when only post-cut bars were corrupted. ${detail}`,
    );
  }
  return report;
}
