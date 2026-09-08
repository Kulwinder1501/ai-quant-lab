import { createHash } from "node:crypto";

/*
 * v2: the liquidity objective changed from the nearest ERL above/below price to the farthest one
 * beyond equilibrium. Bumped rather than left alone because `ict_state_snapshots` is keyed on
 * (instrument, timeframe, bar_time, engine_version, config_hash) -- and the selection lives in
 * `liquidity.ts`, not in `IctEngineConfig`, so the config hash does NOT move with it. Without the
 * bump, 12,622 rows of v1 geometry would keep being served under the same key as new v2 rows and
 * the table would silently hold two incompatible geometries.
 */
export const ICT_STATE_ENGINE_VERSION = "ict-state-v2";
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
  /**
   * Where this engine instance gets its directional bias -- which depends on where it sits in the
   * fractal chain, so it cannot be a global rule.
   *
   * `HIGHER_TIMEFRAME` (default, the execution level): bias must be supplied by the caller from a
   * higher timeframe. Reading it from this level's own structure is what made the bias pillar a
   * restatement of the structure pillar.
   *
   * `OWN_STRUCTURE` (the top of the chain): the swing sequence at this level IS the price-action
   * read, per lecture 9 -- the monthly's own highs and lows establish the macro bias, which is then
   * carried down. Without this the chain never terminates and every level resolves to UNKNOWN.
   */
  readonly biasSource: "HIGHER_TIMEFRAME" | "OWN_STRUCTURE";
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
  biasSource: "HIGHER_TIMEFRAME",
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
