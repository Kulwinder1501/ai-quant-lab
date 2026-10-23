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
 *
 * When IV is null, every Greek on that leg is forced null — never invent at a house vol.
 */

export type GreeksMetric = "iv" | "delta" | "gamma" | "theta" | "vega";

export const GREEKS_METRIC_UNIT_LABEL: Record<GreeksMetric, string> = {
  iv: "IV (absolute; chart as %)",
  delta: "delta (per 1 pt underlying)",
  gamma: "gamma (Δ delta per 1 pt underlying)",
  theta: "theta (premium per calendar day)",
  vega: "vega (premium per 1 IV point)",
};

export const GREEKS_MODEL_DERIVED_LABEL =
  "Model-derived (Black–Scholes from mid-price), not exchange data";

export interface GreeksStrikeLegInput {
  impliedVolatility: number | null;
  impliedVolatilityRefusal: string | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface GreeksStrikeInput {
  strikePrice: number;
  call: GreeksStrikeLegInput | null;
  put: GreeksStrikeLegInput | null;
}

export interface GreeksByStrikePoint {
  strike: number;
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
  /** Plot values for the selected metric; put side is negated for a mirrored axis. Null = gap. */
  callMetricPlot: number | null;
  putMetricPlot: number | null;
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
}

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

function mirroredPut(value: number | null): number | null {
  if (value === null) return null;
  if (value === 0) return 0;
  return -value;
}

function toPoint(row: GreeksStrikeInput, metric: GreeksMetric): GreeksByStrikePoint {
  const call = sanitizeLeg(row.call);
  const put = sanitizeLeg(row.put);
  const callMetric = metricValue(call, metric);
  const putMetric = metricValue(put, metric);
  return {
    strike: row.strikePrice,
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
    callMetricPlot: callMetric,
    putMetricPlot: mirroredPut(putMetric),
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

  return {
    points: selected.map((row) => toPoint(row, options.metric)),
    metric: options.metric,
    unitLabel: GREEKS_METRIC_UNIT_LABEL[options.metric],
    modelDerivedLabel: GREEKS_MODEL_DERIVED_LABEL,
    windowApplied,
    atmStrike,
    windowCenter,
  };
}
