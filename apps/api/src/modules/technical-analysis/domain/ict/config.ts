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
  /**
   * Whether a FAILED order block survives as an opposite-side POI.
   *
   * Lecture 7 says it does: an order block that price closed through is not dead, it is a mitigation
   * block (continuation) or a breaker block (reversal), and both are tradeable from the other side.
   * The engine instead marks it INVALIDATED and prunes it, so the doctrine's second-chance POI has
   * never existed here.
   *
   * Default `false`, which reproduces that pruning exactly. Turning it on ADDS points of interest
   * that never previously existed, so it is a behaviour change and is measured as one rather than
   * shipped as a bug fix.
   *
   * Measured 2026-09-23 on `ict-structure-v1`'s two live cells (`--ict-inverted-poi true`), verdict
   * NO_EDGE -- see the falsification program doc, Amendment 5. Worse than every arm measured before
   * it: NIFTY50 doesn't even agree with itself (2025 +753.65, 2026 holdout -210.60), and BANKNIFTY
   * flips from +4,319.60 to -842.05.
   */
  readonly invertedBlocksRemainPoi: boolean;
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
  invertedBlocksRemainPoi: false,
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
   * The ITH/ITL/STH/STL swing hierarchy (see `swing-hierarchy.ts`), derived from the same confirmed
   * pivots `structure` is derived from. A separate field rather than folded into `structure` because
   * it is a genuinely different classification (a nested "swing of swings" over the raw pivot
   * stream) from `structure`'s single most-recent HH/HL/LL/LH per role.
   */
  readonly swingHierarchy: import("./swing-hierarchy.js").SwingHierarchySnapshot;
  /**
   * The most recently confirmed Change in State of Delivery (see cisd.ts), persisted across bars
   * like `zones.ts`'s own `lastSweep` -- not ephemeral like `structure.lastEvent`, which is null on
   * every bar it doesn't fire on. A strategy asking "was there a recent CISD in my direction" needs
   * the event to still be visible several bars after it confirmed, and can compute its own age from
   * `confirmingCandleIndex` against the current bar. Null until the first leg transition confirms one.
   */
  readonly cisd: import("./cisd.js").CisdEvent | null;
  /**
   * Every currently-active overlapping opposing-FVG pair (see bpr.ts), recomputed fresh each bar --
   * not persisted like `cisd`, because it needs no persistence: it derives entirely from
   * `zones.activeFvgs`, which is already carried on this same snapshot, so it is automatically
   * correct for exactly as long as its constituent gaps remain active and never goes stale.
   */
  readonly balancedPriceRanges: readonly import("./bpr.js").BalancedPriceRange[];
  /**
   * Direction of the higher-timeframe (fractal) bias supplied to the engine, or
   * null when no HTF projection was available. Carried separately from the local
   * bias so the strategy can require fractal alignment without the HTF value
   * silently overwriting the local one.
   */
  readonly htfBias: import("./bias.js").IctBiasDirection | null;
  readonly coverage: PillarCoverage;
}
