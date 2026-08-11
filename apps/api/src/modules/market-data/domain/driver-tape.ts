/**
 * Live index-driver tape metrics for research UX and soft agent filters.
 *
 * Built from approximate weight × day% contribution points (Yahoo session quotes).
 * Not exchange-official free-float contribution, and not an ML feature schema column.
 *
 * Soft-filter contract matches institutional flow: missing / thin coverage → no
 * adjustment (never invent a "flat market").
 */

export interface DriverContribution {
  weightPct: number;
  estPts: number;
}

export interface DriverTapeMetrics {
  /** Fraction of quoted drivers with estPts > 0. */
  advanceShare: number;
  /** Fraction of quoted drivers with estPts < 0. */
  declineShare: number;
  /** Top-3 |estPts| / sum(|estPts|). 1 when a single name dominates. */
  concentration: number;
  /** Quoted drivers / roster size. */
  coverage: number;
  quotedCount: number;
  rosterCount: number;
  estNetPts: number;
}

export interface DriverTapeBias {
  adjustment: number;
  reasoning: string | null;
}

/** Refuse to bias when fewer than this share of the roster quoted. */
export const DRIVER_TAPE_MIN_COVERAGE = 0.7;

/**
 * Pure metrics over quoted contributions.
 * `rosterCount` is the full universe size so coverage reflects missing Yahoo quotes.
 */
export function computeDriverTapeMetrics(
  drivers: readonly DriverContribution[],
  rosterCount: number,
): DriverTapeMetrics | null {
  if (rosterCount <= 0 || drivers.length === 0) return null;

  const quotedCount = drivers.length;
  const coverage = quotedCount / rosterCount;
  let advances = 0;
  let declines = 0;
  let estNetPts = 0;
  const absPts: number[] = [];

  for (const row of drivers) {
    estNetPts += row.estPts;
    const abs = Math.abs(row.estPts);
    absPts.push(abs);
    if (row.estPts > 0) advances += 1;
    else if (row.estPts < 0) declines += 1;
  }

  const absSum = absPts.reduce((sum, value) => sum + value, 0);
  absPts.sort((a, b) => b - a);
  const top3 = absPts.slice(0, 3).reduce((sum, value) => sum + value, 0);
  const concentration = absSum > 0 ? top3 / absSum : 0;

  return {
    advanceShare: advances / quotedCount,
    declineShare: declines / quotedCount,
    concentration,
    coverage,
    quotedCount,
    rosterCount,
    estNetPts,
  };
}

/**
 * Soft confidence adjustment for a stated LONG or SHORT thesis.
 *
 * Broad participation in the thesis direction adds a little; a narrow / top-heavy
 * tape against the thesis subtracts more (adverse  asymmetric, like FII flow).
 */
export function driverTapeBias(
  side: "LONG" | "SHORT",
  metrics: DriverTapeMetrics | null,
): DriverTapeBias {
  if (metrics === null || metrics.coverage < DRIVER_TAPE_MIN_COVERAGE) {
    return { adjustment: 0, reasoning: null };
  }

  const agreeing =
    side === "LONG" ? metrics.advanceShare : metrics.declineShare;
  const concentrationPct = (metrics.concentration * 100).toFixed(0);
  const agreeingPct = (agreeing * 100).toFixed(0);

  if (agreeing >= 0.55 && metrics.concentration <= 0.65) {
    return {
      adjustment: 8,
      reasoning:
        `Driver tape supports ${side}: ${agreeingPct}% of quoted names move with the thesis `
        + `(concentration top-3 ${concentrationPct}%). Approximate weights — soft context only.`,
    };
  }

  if (agreeing < 0.4) {
    const topHeavy =
      metrics.concentration >= 0.65
        ? ` Top-3 names hold ${concentrationPct}% of |pts| — narrow leadership.`
        : "";
    return {
      adjustment: metrics.concentration >= 0.65 ? -18 : -12,
      reasoning:
        `Driver tape weak for ${side}: only ${agreeingPct}% of quoted names agree.`
        + `${topHeavy} Approximate weights — soft context only.`,
    };
  }

  if (metrics.concentration >= 0.7 && agreeing < 0.5) {
    return {
      adjustment: -10,
      reasoning:
        `Driver tape top-heavy for ${side}: concentration ${concentrationPct}% with only `
        + `${agreeingPct}% breadth. Approximate weights — soft context only.`,
    };
  }

  return { adjustment: 0, reasoning: null };
}
