import { createHash } from "node:crypto";

export const ICT_STATE_ENGINE_VERSION = "ict-state-v1";
export const ICT_STRUCTURE_STRATEGY_KEY = "ict-structure-v1";

export interface IctEngineConfig {
  readonly pivotLength: number;
  readonly fvgMinTickSizeMultiple: number;
  readonly obDisplacementBodyAtrMultiple: number;
  readonly obMeanThresholdFraction: number; // Mean Threshold = 0.50
  readonly equalHighLowTolerancePct: number; // 0.05%
  readonly strongCloseThresholdFraction: number; // e.g. upper/lower 25% of bar or past PDH/PDL
  readonly dealingRangeMinAtrMultiple: number;
  readonly maxSignalAgeBars: number;
  readonly maxUnderlyingDriftBps: number;
}

export const defaultIctEngineConfig: IctEngineConfig = {
  pivotLength: 3,
  fvgMinTickSizeMultiple: 1.0,
  obDisplacementBodyAtrMultiple: 1.5,
  obMeanThresholdFraction: 0.5,
  equalHighLowTolerancePct: 0.0005, // 0.05%
  strongCloseThresholdFraction: 0.25,
  dealingRangeMinAtrMultiple: 2.0,
  maxSignalAgeBars: 3,
  maxUnderlyingDriftBps: 25.0, // 25 bps drift tolerance
};

export function computeIctConfigHash(config: IctEngineConfig = defaultIctEngineConfig): string {
  const sortedKeys = Object.keys(config).sort() as (keyof IctEngineConfig)[];
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    normalized[k] = config[k];
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type PillarCoverageState = "COMPLETE" | "NOT_COVERED" | "UNKNOWN";

export interface PillarCoverage {
  readonly structure: PillarCoverageState;
  readonly zones: PillarCoverageState;
  readonly sessionLevels: PillarCoverageState;
  readonly bias: PillarCoverageState;
  readonly liquidity: PillarCoverageState;
  readonly htf: PillarCoverageState;
}

export interface IctStateCompositeSnapshot {
  readonly engineVersion: string;
  readonly configHash: string;
  readonly barIndex: number;
  readonly barTime: Date;
  readonly structure: import("./structure.js").IctStructureSnapshot;
  readonly zones: import("./zones.js").IctZoneSnapshot;
  readonly sessionLevels: import("./session-levels.js").SessionLevelsSnapshot;
  readonly bias: import("./bias.js").IctBiasSnapshot;
  readonly liquidity: import("./liquidity.js").IctLiquiditySnapshot;
  /**
   * Direction of the higher-timeframe (fractal) bias supplied to the engine, or
   * null when no HTF projection was available. Carried separately from the local
   * bias so the strategy can require fractal alignment without the HTF value
   * silently overwriting the local one.
   */
  readonly htfBias: import("./bias.js").IctBiasDirection | null;
  readonly coverage: PillarCoverage;
}
