export const indicatorCodes = [
  "SMA",
  "EMA",
  "RSI",
  "MACD",
  "ATR",
  "VWAP",
  "BOLLINGER_BANDS",
  "SUPERTREND",
  "FVG",
  "BOS",
  "CHOCH",
  "LIQUIDITY_SWEEP",
  "ORDER_BLOCK",
  "EQUILIBRIUM_ZONE",
] as const;

export type IndicatorCode = (typeof indicatorCodes)[number];
export type IndicatorValues = Record<string, number | string | boolean | null>;

export interface IndicatorDefinitionSpec {
  code: IndicatorCode;
  algorithmVersion: string;
  parameters: Record<string, number | string | boolean>;
  outputSchema: Record<string, string>;
}

export interface IndicatorCandle {
  id: string;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorPoint {
  candleId: string;
  values: IndicatorValues;
}

export interface IndicatorDefinition {
  id: string;
  code: IndicatorCode;
  algorithmVersion: string;
  parameters: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface EnsureIndicatorDefinitionInput extends IndicatorDefinitionSpec {
  parametersHash: string;
}

export interface IndicatorDefinitionRepository {
  ensure(input: EnsureIndicatorDefinitionInput): Promise<IndicatorDefinition>;
}

export interface IndicatorSnapshotInput {
  candleId: string;
  indicatorDefinitionId: string;
  values: IndicatorValues;
}

export interface IndicatorSnapshotRepository {
  /**
   * Writes a batch. Deliberately not a single-row `upsert`: the caller has one row per
   * (candle, definition), so a per-row method meant ~810,000 awaited round trips for one
   * NIFTY50 1m recompute, and that job runs every minute.
   */
  upsertMany(inputs: readonly IndicatorSnapshotInput[]): Promise<void>;
}

export const defaultIndicatorDefinitions: readonly IndicatorDefinitionSpec[] = [
  { code: "SMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, outputSchema: { value: "number" } },
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, outputSchema: { value: "number" } },
  // EMA-9 is the fast leg the momentum-scalp strategy pairs with the 20-period
  // slow EMA. Without it in the registry, `analysis:calculate-indicators` never
  // computes it, so the scalp strategy's resolveIndicators always fails on real
  // data and it can produce no ideas in either direction. The ML feature pipeline
  // selects EMA strictly at period 20 (see _INDICATOR_PARAMETERS), so this extra
  // definition does not touch the immutable feature schema.
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 9 }, outputSchema: { value: "number" } },
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, outputSchema: { value: "number" } },
  { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, outputSchema: { value: "number" } },
  { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, outputSchema: { value: "number" } },
  {
    code: "MACD",
    algorithmVersion: "ta-v1",
    parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    outputSchema: { macd: "number", signal: "number|null", histogram: "number|null" },
  },
  { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, outputSchema: { value: "number" } },
  { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, outputSchema: { value: "number" } },
  {
    code: "BOLLINGER_BANDS",
    algorithmVersion: "ta-v1",
    parameters: { period: 20, standardDeviations: 2 },
    outputSchema: { middle: "number", upper: "number", lower: "number", standardDeviation: "number" },
  },
  {
    code: "SUPERTREND",
    algorithmVersion: "ta-v1",
    parameters: { atrPeriod: 10, multiplier: 3 },
    outputSchema: { value: "number", upperBand: "number", lowerBand: "number", trend: "UP|DOWN" },
  },
  {
    code: "FVG",
    algorithmVersion: "ta-v1",
    parameters: {},
    outputSchema: { top: "number", bottom: "number", type: "BULLISH|BEARISH", active: "boolean" },
  },
  {
    code: "BOS",
    algorithmVersion: "ta-v1",
    parameters: { pivotLength: 5 },
    outputSchema: { type: "BULLISH_BOS|BEARISH_BOS", level: "number" },
  },
  {
    code: "CHOCH",
    algorithmVersion: "ta-v1",
    parameters: { pivotLength: 5 },
    outputSchema: { type: "BULLISH_CHOCH|BEARISH_CHOCH", level: "number" },
  },
  {
    code: "LIQUIDITY_SWEEP",
    algorithmVersion: "ta-v1",
    parameters: { pivotLength: 5 },
    outputSchema: { type: "BULLISH_SWEEP|BEARISH_SWEEP", level: "number" },
  },
  {
    code: "ORDER_BLOCK",
    algorithmVersion: "ta-v1",
    parameters: { displacementThreshold: 1.5 },
    outputSchema: { type: "BULLISH_OB|BEARISH_OB", top: "number", bottom: "number" },
  },
  {
    code: "EQUILIBRIUM_ZONE",
    algorithmVersion: "ta-v1",
    parameters: { pivotLength: 5 },
    outputSchema: { top: "number", bottom: "number", equilibrium: "number" },
  },
];
