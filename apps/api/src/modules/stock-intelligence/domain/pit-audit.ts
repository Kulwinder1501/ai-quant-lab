import { findLookaheadViolations, inspectPointInTime, type LookaheadViolation } from "../../research/domain/lookahead-guard.js";
import type { CanonicalMarketBar } from "./adapters.js";
import { assertClocksAreOrdered } from "./timestamps.js";

/**
 * Bars knowable at `dataCutoff`. Equality is legal: a bar whose close *is* the cutoff
 * may be used. Strictly later closes are future data.
 */
export function selectBarsAsOf(
  bars: readonly CanonicalMarketBar[],
  dataCutoff: Date,
): CanonicalMarketBar[] {
  return bars.filter((bar) => {
    const claim = inspectPointInTime({
      label: `bar:${bar.instrumentId}:${bar.closeTime.toISOString()}`,
      featureAsOf: bar.availableAt,
      decidedAt: dataCutoff,
    });
    return claim === null;
  });
}

export interface BarPitAudit {
  readonly cutoff: Date;
  readonly inputCount: number;
  readonly keptCount: number;
  readonly violations: readonly LookaheadViolation[];
  readonly clockOrderFailures: readonly string[];
  readonly passed: boolean;
}

export function auditBarsPointInTime(
  bars: readonly CanonicalMarketBar[],
  dataCutoff: Date,
): BarPitAudit {
  const clockOrderFailures: string[] = [];
  for (const bar of bars) {
    try {
      assertClocksAreOrdered(bar, `bar:${bar.instrumentId}:${bar.closeTime.toISOString()}`);
    } catch (error) {
      clockOrderFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const claims = bars.map((bar) => ({
    label: `bar:${bar.instrumentId}:${bar.closeTime.toISOString()}`,
    featureAsOf: bar.availableAt,
    decidedAt: dataCutoff,
  }));
  const violations = findLookaheadViolations(claims);
  const kept = selectBarsAsOf(bars, dataCutoff);

  return {
    cutoff: dataCutoff,
    inputCount: bars.length,
    keptCount: kept.length,
    violations,
    clockOrderFailures,
    passed: violations.length === 0 && clockOrderFailures.length === 0,
  };
}

function barFingerprint(bar: CanonicalMarketBar): string {
  return `${bar.closeTime.toISOString()}|${bar.close}|${bar.open}|${bar.high}|${bar.low}`;
}

export interface BarFutureInjectionReport {
  readonly cutoff: Date;
  readonly protectedBarCount: number;
  readonly corruptedBarCount: number;
  readonly findings: readonly { closeTime: string; baseline: string; corrupted: string }[];
  readonly leaked: boolean;
}

/**
 * Corrupts post-cutoff closes and asserts `select` did not read them.
 *
 * A filter that returns every bar, or that keys off close price instead of
 * `availableAt`, will fail. Vacuous (no protected bar) also fails.
 */
export function detectBarFutureInjection(input: {
  bars: readonly CanonicalMarketBar[];
  cutoff: Date;
  select?: (bars: readonly CanonicalMarketBar[], cutoff: Date) => readonly CanonicalMarketBar[];
}): BarFutureInjectionReport {
  const select = input.select ?? selectBarsAsOf;
  const cutoff = input.cutoff;
  const corrupted = input.bars.map((bar) => {
    if (inspectPointInTime({
      label: "corrupt-candidate",
      featureAsOf: bar.availableAt,
      decidedAt: cutoff,
    }) === null) {
      return bar;
    }
    return { ...bar, close: "999999.00", high: "999999.00" };
  });
  const corruptedBarCount = corrupted.filter((bar, index) => bar !== input.bars[index]).length;

  const baseline = select(input.bars, cutoff);
  const after = select(corrupted, cutoff);
  const afterByTime = new Map(after.map((bar) => [bar.closeTime.toISOString(), bar]));
  const findings: Array<{ closeTime: string; baseline: string; corrupted: string }> = [];

  for (const bar of baseline) {
    const other = afterByTime.get(bar.closeTime.toISOString());
    if (!other) {
      findings.push({
        closeTime: bar.closeTime.toISOString(),
        baseline: barFingerprint(bar),
        corrupted: "absent",
      });
      continue;
    }
    if (barFingerprint(other) !== barFingerprint(bar)) {
      findings.push({
        closeTime: bar.closeTime.toISOString(),
        baseline: barFingerprint(bar),
        corrupted: barFingerprint(other),
      });
    }
  }

  for (const bar of after) {
    const leak = inspectPointInTime({
      label: `selected:${bar.closeTime.toISOString()}`,
      featureAsOf: bar.availableAt,
      decidedAt: cutoff,
    });
    if (leak) {
      findings.push({
        closeTime: bar.closeTime.toISOString(),
        baseline: "not selected",
        corrupted: barFingerprint(bar),
      });
    }
  }

  return {
    cutoff,
    protectedBarCount: baseline.length,
    corruptedBarCount,
    findings,
    leaked: findings.length > 0,
  };
}

export function assertNoBarFutureInjection(input: {
  bars: readonly CanonicalMarketBar[];
  cutoff: Date;
  select?: (bars: readonly CanonicalMarketBar[], cutoff: Date) => readonly CanonicalMarketBar[];
}): BarFutureInjectionReport {
  const report = detectBarFutureInjection(input);
  if (report.protectedBarCount === 0) {
    throw new Error(
      `Bar future-injection sentinel protected no bars at ${input.cutoff.toISOString()}; the check was vacuous.`,
    );
  }
  if (report.corruptedBarCount === 0) {
    throw new Error(
      `Bar future-injection sentinel corrupted no bars at ${input.cutoff.toISOString()}; the cut is at or after the last bar.`,
    );
  }
  if (report.leaked) {
    const detail = report.findings.slice(0, 5)
      .map((finding) => `${finding.closeTime}: ${finding.baseline} -> ${finding.corrupted}`)
      .join("; ");
    throw new Error(
      `FUTURE_INJECTION_DETECTED: ${report.findings.length} pre-cut bar(s) changed when only post-cut closes were corrupted. ${detail}`,
    );
  }
  return report;
}
