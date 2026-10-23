/**
 * Pure Greeks-by-strike series builder for the option-chain chart.
 *
 * No React. Null stays null so an unsolved IV never plots as zero.
 *
 * ## Units (Leg + packages/pricing `priceEuropeanOption`)
 * These are **model-derived** (Black–Scholes from mid), not exchange data.
 * - impliedVolatility: absolute vol (0.155 = 15.5%); null + refusal reason when unsolved
 * - delta: ∂V/∂S per 1 point of underlying
 * - gamma: ∂²V/∂S² = change in delta per 1 point of underlying (`pdf(d1)/(S·σ·√T)`)
 * - theta: currency (premium) per calendar day; negative for a long option
 * - vega: premium per 1 absolute percentage point of IV
 * Theta and vega are per 1 unit of the underlying, not per lot.
 *
 * ## Signs
 * Plot values are the raw Greeks with their natural signs, call and put on the *same* axis. An
 * earlier version mirrored the put side by negating it, which is right for open interest (a
 * magnitude) and wrong here: put theta (negative) plotted upward, put delta (negative) plotted on
 * the call side, and put IV/gamma/vega plotted as negative numbers that cannot exist.
 *
 * When IV is null, every Greek on that leg is forced null — never invent at a house vol.
 */

export type GreeksMetric = "iv" | "delta" | "gamma" | "theta" | "vega";

export const GREEKS_METRIC_UNIT_LABEL: Record<GreeksMetric, string> = {
  iv: "IV (%, annualised)",
  delta: "delta (per 1 pt underlying)",
  gamma: "gamma (Δ delta per 1 pt underlying)",
  theta: "theta (premium per calendar day, per unit)",
  vega: "vega (premium per 1 IV point, per unit)",
};

export const GREEKS_MODEL_DERIVED_LABEL =
  "Model-derived (Black–Scholes from mid-price), not exchange data";

export const GREEKS_PER_UNIT_NOTE =
  "Theta and vega are per 1 unit of the underlying, not per lot: multiply by the contract's lot size for rupees per lot.";

/**
 * What Fyers itself reported for a contract (`greeks=1`), as sent. IV is in PERCENT, where the model's
 * `impliedVolatility` is a fraction. Independent of the model values: it is an observation, so it is kept
 * when the model could not solve an IV and is never nulled by that.
 */
export interface VendorGreeksInput {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatilityPercent: number | null;
}

export interface GreeksStrikeLegInput {
  impliedVolatility: number | null;
  impliedVolatilityRefusal: string | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  vendorGreeks?: VendorGreeksInput | null;
}

export interface GreeksStrikeInput {
  strikePrice: number;
  call: GreeksStrikeLegInput | null;
  put: GreeksStrikeLegInput | null;
}

export interface GreeksByStrikePoint {
  strike: number;
  /** Whether a contract exists on this side at all, as distinct from one that could not be solved. */
  callPresent: boolean;
  putPresent: boolean;
  callIv: number | null;
  putIv: number | null;
  callIvRefusal: string | null;
  putIvRefusal: string | null;
  callDelta: number | null;
  putDelta: number | null;
  callGamma: number | null;
  putGamma: number | null;
  callTheta: number | null;
  putTheta: number | null;
  callVega: number | null;
  putVega: number | null;
  /** Selected metric in display units (IV in percent), natural sign. Null = gap, never zero. */
  callMetricPlot: number | null;
  putMetricPlot: number | null;
  /**
   * Fyers' own value of the selected metric for each side, in the same display units. IV, gamma, theta and
   * vega are one value per strike so the two sides coincide; delta differs (put = call - 1). Null = not stored.
   */
  callVendorPlot: number | null;
  putVendorPlot: number | null;
}

export interface UnsolvedSideSummary {
  /** Contracts present on this side within the window. */
  legs: number;
  /** Of those, how many had no solvable IV and therefore carry no Greeks. */
  unsolved: number;
  /** Refusal reason → count. A missing reason is keyed `UNKNOWN`. */
  reasons: Record<string, number>;
}

export interface UnsolvedSummary {
  calls: UnsolvedSideSummary;
  puts: UnsolvedSideSummary;
}

export interface BuildGreeksByStrikeOptions {
  metric: GreeksMetric;
  window?: number | null;
  atmStrike?: number | null;
}

export interface BuildGreeksByStrikeResult {
  points: GreeksByStrikePoint[];
  metric: GreeksMetric;
  unitLabel: string;
  modelDerivedLabel: string;
  windowApplied: number | null;
  atmStrike: number | null;
  windowCenter: "atm" | "median" | "none";
  unsolved: UnsolvedSummary;
  /** Largest absolute plotted value across both sides; 0 when nothing plotted. */
  maxAbsPlot: number;
  /** Decimal places that keep this metric readable at this magnitude (axis and tooltip). */
  axisDecimals: number;
  vendor: VendorComparison;
}

export interface VendorComparison {
  /** Strikes in the window where Fyers' value for this metric is stored, on at least one side. */
  strikesWithVendor: number;
  strikesInWindow: number;
  /** Side-by-side pairs where both our value and Fyers' exist. */
  pairsCompared: number;
  /** Mean and largest |Fyers - ours| over those pairs, in display units. Null when nothing compared. */
  meanAbsGap: number | null;
  maxAbsGap: number | null;
  maxGapStrike: number | null;
  /** What to know about Fyers' convention for this metric. */
  note: string;
}

/** Fyers' conventions, measured 2026-10-23 on NIFTY50, BANKNIFTY and SBIN. One note per metric. */
export const VENDOR_METRIC_NOTE: Record<GreeksMetric, string> = {
  iv: "Fyers IV is one value per strike, shared by call and put, in percent.",
  delta: "Fyers delta: put = call - 1 exactly. It prices off the market forward, as the model values do.",
  gamma: "Fyers gamma is reported to four decimals only, too coarse for index options (BANKNIFTY showed two distinct values across seven strikes). Use the model gamma.",
  theta: "Fyers theta is one value per strike, with no call/put rate-carry term, so it sits between the model's call and put theta.",
  vega: "Fyers vega is one value per strike, per 1 vol point per unit.",
};

/** Drop Greeks when IV is missing so a stale/partial leg cannot invent values. */
function sanitizeLeg(leg: GreeksStrikeLegInput | null): GreeksStrikeLegInput | null {
  if (leg === null) return null;
  if (leg.impliedVolatility === null) {
    return {
      impliedVolatility: null,
      impliedVolatilityRefusal: leg.impliedVolatilityRefusal,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
    };
  }
  return leg;
}

function metricValue(leg: GreeksStrikeLegInput | null, metric: GreeksMetric): number | null {
  if (leg === null) return null;
  switch (metric) {
    case "iv":
      // Chart as percent points for readability (0.155 → 15.5).
      return leg.impliedVolatility === null ? null : leg.impliedVolatility * 100;
    case "delta":
      return leg.delta;
    case "gamma":
      return leg.gamma;
    case "theta":
      return leg.theta;
    case "vega":
      return leg.vega;
  }
}

/** Fyers' value of one metric for one leg, in the same display units as `metricValue`. */
function vendorMetricValue(leg: GreeksStrikeLegInput | null, metric: GreeksMetric): number | null {
  const vendor = leg?.vendorGreeks;
  if (!vendor) return null;
  switch (metric) {
    case "iv":
      return vendor.impliedVolatilityPercent;
    case "delta":
      return vendor.delta;
    case "gamma":
      return vendor.gamma;
    case "theta":
      return vendor.theta;
    case "vega":
      return vendor.vega;
  }
}

function toPoint(row: GreeksStrikeInput, metric: GreeksMetric): GreeksByStrikePoint {
  const call = sanitizeLeg(row.call);
  const put = sanitizeLeg(row.put);
  return {
    strike: row.strikePrice,
    callPresent: call !== null,
    putPresent: put !== null,
    callIv: call?.impliedVolatility ?? null,
    putIv: put?.impliedVolatility ?? null,
    callIvRefusal: call?.impliedVolatilityRefusal ?? null,
    putIvRefusal: put?.impliedVolatilityRefusal ?? null,
    callDelta: call?.delta ?? null,
    putDelta: put?.delta ?? null,
    callGamma: call?.gamma ?? null,
    putGamma: put?.gamma ?? null,
    callTheta: call?.theta ?? null,
    putTheta: put?.theta ?? null,
    callVega: call?.vega ?? null,
    putVega: put?.vega ?? null,
    callMetricPlot: metricValue(call, metric),
    putMetricPlot: metricValue(put, metric),
    // Read from the raw rows, not the sanitised legs: an observation does not depend on our solver.
    callVendorPlot: vendorMetricValue(row.call, metric),
    putVendorPlot: vendorMetricValue(row.put, metric),
  };
}

function indexClosestTo(sorted: readonly GreeksStrikeInput[], target: number): number {
  let bestIndex = 0;
  let bestDistance = Math.abs(sorted[0]!.strikePrice - target);
  for (let i = 1; i < sorted.length; i += 1) {
    const distance = Math.abs(sorted[i]!.strikePrice - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function summariseSide(
  points: readonly GreeksByStrikePoint[],
  present: (p: GreeksByStrikePoint) => boolean,
  iv: (p: GreeksByStrikePoint) => number | null,
  refusal: (p: GreeksByStrikePoint) => string | null,
): UnsolvedSideSummary {
  const summary: UnsolvedSideSummary = { legs: 0, unsolved: 0, reasons: {} };
  for (const point of points) {
    if (!present(point)) continue;
    summary.legs += 1;
    if (iv(point) === null) {
      summary.unsolved += 1;
      const key = refusal(point) ?? "UNKNOWN";
      summary.reasons[key] = (summary.reasons[key] ?? 0) + 1;
    }
  }
  return summary;
}

function compareWithVendor(points: readonly GreeksByStrikePoint[], metric: GreeksMetric): VendorComparison {
  let strikesWithVendor = 0;
  let pairs = 0;
  let sum = 0;
  let max: { gap: number; strike: number } | null = null;

  for (const point of points) {
    if (point.callVendorPlot !== null || point.putVendorPlot !== null) strikesWithVendor += 1;
    for (const [ours, theirs] of [
      [point.callMetricPlot, point.callVendorPlot],
      [point.putMetricPlot, point.putVendorPlot],
    ] as const) {
      if (ours === null || theirs === null) continue;
      const gap = Math.abs(theirs - ours);
      pairs += 1;
      sum += gap;
      if (max === null || gap > max.gap) max = { gap, strike: point.strike };
    }
  }

  return {
    strikesWithVendor,
    strikesInWindow: points.length,
    pairsCompared: pairs,
    meanAbsGap: pairs > 0 ? sum / pairs : null,
    maxAbsGap: max?.gap ?? null,
    maxGapStrike: max?.strike ?? null,
    note: VENDOR_METRIC_NOTE[metric],
  };
}

/**
 * How many decimals keep a Greek readable at the magnitude actually on screen.
 *
 * Fixed precision fails for gamma: an ATM index option's gamma is of order 1e-3, so three decimals
 * would label every axis tick 0.000 or 0.001. Gamma therefore takes enough decimals for about three
 * significant figures at the largest plotted value; the others have a stable natural range.
 */
export function greeksAxisDecimals(metric: GreeksMetric, maxAbs: number): number {
  switch (metric) {
    case "iv":
      return 1;
    case "delta":
      return 2;
    case "theta":
    case "vega":
      return maxAbs >= 100 ? 0 : maxAbs >= 10 ? 1 : 2;
    case "gamma": {
      if (!Number.isFinite(maxAbs) || maxAbs <= 0) return 4;
      const decimals = 2 - Math.floor(Math.log10(maxAbs));
      return Math.min(8, Math.max(3, decimals));
    }
  }
}

/** A Greek as text at `decimals` places, with an em dash for a gap. IV carries its percent sign. */
export function formatGreekValue(value: number | null, metric: GreeksMetric, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const text = value.toFixed(decimals);
  return metric === "iv" ? `${text}%` : text;
}

export function buildGreeksByStrike(
  strikes: readonly GreeksStrikeInput[],
  options: BuildGreeksByStrikeOptions,
): BuildGreeksByStrikeResult {
  const sorted = [...strikes].sort((a, b) => a.strikePrice - b.strikePrice);
  const atmStrike = options.atmStrike ?? null;
  const window = options.window ?? null;

  let selected = sorted;
  let windowApplied: number | null = null;
  let windowCenter: BuildGreeksByStrikeResult["windowCenter"] = "none";

  if (window !== null && window >= 0 && sorted.length > 0) {
    const hasAtm = atmStrike !== null && Number.isFinite(atmStrike);
    const centerIndex = hasAtm
      ? indexClosestTo(sorted, atmStrike)
      : Math.floor((sorted.length - 1) / 2);
    windowCenter = hasAtm ? "atm" : "median";
    const from = Math.max(0, centerIndex - window);
    const to = Math.min(sorted.length - 1, centerIndex + window);
    selected = sorted.slice(from, to + 1);
    windowApplied = window;
  }

  const points = selected.map((row) => toPoint(row, options.metric));
  let maxAbsPlot = 0;
  for (const point of points) {
    for (const value of [point.callMetricPlot, point.putMetricPlot]) {
      if (value !== null && Number.isFinite(value)) maxAbsPlot = Math.max(maxAbsPlot, Math.abs(value));
    }
  }

  return {
    points,
    metric: options.metric,
    unitLabel: GREEKS_METRIC_UNIT_LABEL[options.metric],
    modelDerivedLabel: GREEKS_MODEL_DERIVED_LABEL,
    windowApplied,
    atmStrike,
    windowCenter,
    unsolved: {
      calls: summariseSide(points, (p) => p.callPresent, (p) => p.callIv, (p) => p.callIvRefusal),
      puts: summariseSide(points, (p) => p.putPresent, (p) => p.putIv, (p) => p.putIvRefusal),
    },
    maxAbsPlot,
    axisDecimals: greeksAxisDecimals(options.metric, maxAbsPlot),
    vendor: compareWithVendor(points, options.metric),
  };
}
