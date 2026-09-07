/**
 * Investor-facing status. `UNDER_REVIEW` is a display-layer overlay; the original
 * snapshot stays immutable. HTTP/UI remain disabled until Gate 7.
 */
export const predictionSnapshotStatuses = [
  "VALID",
  "INSUFFICIENT_DATA",
  "INSUFFICIENT_ANALOGUES",
  "OUT_OF_REGIME",
  "CALIBRATION_UNCERTAIN",
  "STALE_DATA",
  "UNDER_REVIEW",
] as const;

export type PredictionSnapshotStatus = (typeof predictionSnapshotStatuses)[number];

export const stockIntelligenceMacroRegimes = ["expansion", "slowdown", "recovery", "recession"] as const;
export type StockIntelligenceMacroRegime = (typeof stockIntelligenceMacroRegimes)[number];

export const stockIntelligenceVolatilityRegimes = ["low", "normal", "elevated", "crisis"] as const;
export type StockIntelligenceVolatilityRegime = (typeof stockIntelligenceVolatilityRegimes)[number];

/**
 * MVP two-dimension bucket. Distinct from the trading lab's `HIGH_VOL` / `LOW_VOL`
 * on `regime_observations` — that series is an intraday VIX-ratio gate and must not
 * be overwritten by this taxonomy.
 */
export function regimeBucket(
  macro: StockIntelligenceMacroRegime,
  volatility: StockIntelligenceVolatilityRegime,
): `${StockIntelligenceMacroRegime}:${StockIntelligenceVolatilityRegime}` {
  return `${macro}:${volatility}`;
}

export const TAIL_REGIME_BUCKETS: readonly string[] = [
  "recession:crisis",
  "recession:elevated",
  "recession:normal",
  "recession:low",
  "slowdown:elevated",
  "slowdown:crisis",
  "expansion:crisis",
  "recovery:crisis",
];

export function isTailRegimeBucket(bucket: string): boolean {
  const [macro, volatility] = bucket.split(":");
  if (volatility === "crisis" || macro === "recession") return true;
  return bucket === "slowdown:elevated";
}
