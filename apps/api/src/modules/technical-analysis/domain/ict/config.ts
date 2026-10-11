import { createHash } from "node:crypto";

/*
 * v2: the liquidity objective changed from the nearest ERL above/below price to the farthest one
 * beyond equilibrium. Bumped rather than left alone because `ict_state_snapshots` is keyed on
 * (instrument, timeframe, bar_time, engine_version, config_hash) -- and the selection lives in
 * `liquidity.ts`, not in `IctEngineConfig`, so the config hash does NOT move with it. Without the
 * bump, 12,622 rows of v1 geometry would keep being served under the same key as new v2 rows and
 * the table would silently hold two incompatible geometries.
 */
/*
 * v3 (2026-10-09): snapshots gained `mss`, and fair-value-gap / order-block creation gained ATR size
 * floors, so the zones a given series produces differ from v2's. Bumped for the same reason as v2:
 * the cache key is (instrument, timeframe, bar_time, engine_version, config_hash), and the config
 * hash would move with the new keys anyway, but a bump keeps the intent explicit and stops a v2 row
 * (no `mss`) from ever being served as if it were complete.
 */
export const ICT_STATE_ENGINE_VERSION = "ict-state-v3";
export const ICT_STRUCTURE_STRATEGY_KEY = "ict-structure-v1";

export interface IctEngineConfig {
  readonly pivotLength: number;
  /** @deprecated Never read. Superseded by `fvgMinAtrFraction`; kept so persisted config hashes stay explainable. */
  readonly fvgMinTickSizeMultiple: number;
  /** Minimum fair-value-gap height as a fraction of ATR(14); 0 disables. See `IctZoneLedger`. */
  readonly fvgMinAtrFraction: number;
  /**
   * Minimum displacement-candle body, in ATR(14), for an order block to form AND for a market
   * structure shift's breaking candle. 0 disables the order-block floor. See `mss.ts`.
   */
  readonly displacementMinAtr: number;
  /** A liquidity sweep may be followed by a market structure shift for this many bars. */
  readonly mssSweepLookbackBars: number;
  /**
   * Despite the name this is a ratio against the ORDER BLOCK candle's own body (1.5x), not an ATR
   * multiple -- the name predates that being noticed. The ATR floor is `displacementMinAtr`.
   */
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
  // A structural floor against tick-sized "gaps" and flat "displacement", not a fitted value: a gap
  // under a tenth of an ATR is inside ordinary bar-to-bar noise, and 0.8 ATR is the lower end of
  // what reads as a one-sided candle. Neither was chosen by looking at P&L.
  fvgMinAtrFraction: 0.1,
  displacementMinAtr: 0.8,
  mssSweepLookbackBars: 10,
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

/**
 * Shadow-only observation of `computeDrawOnLiquidity`'s target selection (see liquidity.ts),
 * recorded for future comparison against `liquidity.primaryTarget` -- never read by
 * `ict-structure-v1`, the gold bot, or any other live decision path. See the
 * `drawOnLiquidityState` docstring on `IctStateCompositeSnapshot` below for why this carries only
 * the selected pool and a count rather than the full `DrawOnLiquidityState.candidatePools` array
 * the plan's own type specifies.
 */
export interface DrawOnLiquidityObservation {
  readonly selectedPool: import("./liquidity.js").LiquidityPool | null;
  readonly candidatePoolCount: number;
  readonly direction: -1 | 0 | 1;
  readonly selectionRuleVersion: string;
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
   * The most recently confirmed structural event (BOS/CHOCH/IDM_CONFIRMED/SWEEP), persisted across
   * bars -- same pattern as `cisd` above, for the same reason. `structure.lastEvent` is deliberately
   * ephemeral (null on every bar it doesn't fire on; see its own docstring), which is correct for
   * `zones.ts`'s "did a CHOCH/SWEEP happen on exactly this bar" reads but wrong for anything that
   * needs a STABLE identity for "the currently active confirmed setup" across many bars of
   * re-evaluation -- e.g. a deterministic setupId that must hash the same while the setup is still
   * open, not mint a fresh one every bar. Null until the first structural event ever confirms (the
   * NEUTRAL -> BULLISH/BEARISH trend bootstrap in `structure.ts` fires with no event of its own, so
   * this can legitimately stay null for a window at the very start of a series).
   */
  readonly lastConfirmedStructureEvent: import("./structure.js").StructureEvent | null;
  /**
   * Every currently-active overlapping opposing-FVG pair (see bpr.ts), recomputed fresh each bar --
   * not persisted like `cisd`, because it needs no persistence: it derives entirely from
   * `zones.activeFvgs`, which is already carried on this same snapshot, so it is automatically
   * correct for exactly as long as its constituent gaps remain active and never goes stale.
   */
  readonly balancedPriceRanges: readonly import("./bpr.js").BalancedPriceRange[];
  /**
   * The active market structure shift (see mss.ts): a liquidity sweep followed by a displacement
   * body-close through the preceding swing, with its leg and protective level. Persisted across
   * bars until a body close beyond `legStart` kills it or a newer shift replaces it; null when none
   * is live. Optional only so snapshots built before v3 (tests, old cached rows) still type-check;
   * the engine always sets it and a missing value is read as "no shift".
   */
  readonly mss?: import("./mss.js").MssSnapshot | null;
  /**
   * Direction of the higher-timeframe (fractal) bias supplied to the engine, or
   * null when no HTF projection was available. Carried separately from the local
   * bias so the strategy can require fractal alignment without the HTF value
   * silently overwriting the local one.
   */
  readonly htfBias: import("./bias.js").IctBiasDirection | null;
  readonly coverage: PillarCoverage;
  /**
   * Shadow observation of `computeDrawOnLiquidity`'s own target selection, computed from the same
   * pool catalog `liquidity.primaryTarget` is drawn from (`buildIctLiquidityPools`) but entirely
   * independent of it -- nothing here feeds `liquidity`, and nothing in `liquidity` feeds this.
   * Exists purely so the algorithm is instrumented into real `ict_state_snapshots` rows going
   * forward, enabling a future backtest/comparison against the existing resolver's track record,
   * without changing a single thing about what `ict-structure-v1` (NIFTY50 15m, BANKNIFTY 5m) or the
   * gold bot's shadow-gated entries actually do today.
   *
   * Deliberately NOT the plan's own `DrawOnLiquidityState` shape verbatim: that interface's
   * `candidatePools` is a full `LiquidityPool[]`, and this snapshot is persisted whole via
   * `JSON.stringify` into `ict_state_snapshots` on every bar (see
   * `postgres-strategy-market-context-repository.ts`). `IctLiquiditySnapshot` right above already
   * carries this exact scar: its own docstring records a 10GB-heap OOM from embedding a pool list
   * that grows with the number of distinct confirmed-pivot price levels into every persisted
   * snapshot. Carrying only the one selected pool plus a count reproduces that fix rather than
   * undoing it.
   */
  readonly drawOnLiquidityState: DrawOnLiquidityObservation;
  /**
   * Wilder ATR(14) computed incrementally by the composite engine's own `IctAtrTracker`.
   * Null when insufficient history has elapsed to form the first 14-period window.
   */
  readonly atr14: number | null;
}
