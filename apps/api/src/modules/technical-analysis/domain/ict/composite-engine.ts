import type { CausalCandle } from "./causal-pivot.js";
import {
  ICT_STATE_ENGINE_VERSION,
  computeIctConfigHash,
  defaultIctEngineConfig,
  type DrawOnLiquidityObservation,
  type IctEngineConfig,
  type IctStateCompositeSnapshot,
  type PillarCoverage,
} from "./config.js";
import { IctStructureTracker, type StructureEvent } from "./structure.js";
import { IctZoneLedger } from "./zones.js";
import { IctSessionLevelTracker } from "./session-levels.js";
import { IctBiasTracker, type IctBiasDirection } from "./bias.js";
import { IctLiquidityResolver, buildIctLiquidityPools, computeDrawOnLiquidity } from "./liquidity.js";
import { computeSwingHierarchySnapshot } from "./swing-hierarchy.js";
import { CisdTracker, type CisdEvent } from "./cisd.js";
import { computeBalancedPriceRanges } from "./bpr.js";
import { IctAtrTracker } from "./atr-tracker.js";
import { NSE_IST_PROFILE, type InstrumentProfile } from "../../../platform/calendar/instrument-profile.js";

export class IctCompositeEngine {
  private readonly structTracker: IctStructureTracker;
  private readonly zoneLedger: IctZoneLedger;
  private readonly sessionTracker: IctSessionLevelTracker;
  private readonly biasTracker: IctBiasTracker;
  private readonly liquidityResolver: IctLiquidityResolver;
  private readonly cisdTracker: CisdTracker;
  private lastCisdEvent: CisdEvent | null = null;
  /** Persisted across bars -- see `IctStateCompositeSnapshot.lastConfirmedStructureEvent`'s own docstring. */
  private lastConfirmedStructureEvent: StructureEvent | null = null;
  private readonly configHash: string;
  /**
   * Feeds the shadow `drawOnLiquidityState` observation only (see its docstring on
   * `IctStateCompositeSnapshot`). O(1) per bar by construction -- see `IctAtrTracker`'s own
   * docstring for why that matters here specifically.
   */
  private readonly atrTracker: IctAtrTracker;

  /**
   * `profile` resolves session-date bucketing for both the session-levels and bias pillars.
   * Defaults to `NSE_IST_PROFILE`, which is byte-identical to this engine's pre-existing behaviour
   * -- every current caller gets the same output as before. A caller running this engine over
   * non-NSE candles (XAU_USD, via `instrumentProfileForSymbol`) passes the matching profile instead.
   */
  constructor(
    private readonly config: IctEngineConfig = defaultIctEngineConfig,
    private readonly profile: InstrumentProfile = NSE_IST_PROFILE
  ) {
    this.structTracker = new IctStructureTracker(config.pivotLength);
    this.zoneLedger = new IctZoneLedger(
      config.obDisplacementBodyAtrMultiple,
      config.obMeanThresholdFraction,
      config.invertedBlocksRemainPoi
    );
    this.sessionTracker = new IctSessionLevelTracker(profile);
    this.biasTracker = new IctBiasTracker();
    this.liquidityResolver = new IctLiquidityResolver();
    this.cisdTracker = new CisdTracker();
    this.atrTracker = new IctAtrTracker(14);
    this.configHash = computeIctConfigHash(config);
  }

  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    htfBias?: IctBiasDirection
  ): IctStateCompositeSnapshot {
    const current = candles[currentIndex];
    /*
     * Session levels resolve FIRST now, because structure needs to know whether a prior-day level
     * was swept on this bar -- lecture 5's CHoCH-for-IDM substitution depends on it. The session
     * tracker takes only (candles, index) and never read structure, so the reorder is safe.
     *
     * Gated on `barIndex === currentIndex`: the substitution applies to the swing formed at the
     * sweep, not to every bar for the rest of the session after one.
     */
    const sessionLevels = this.sessionTracker.processCandle(candles, currentIndex);
    const sweep = sessionLevels.lastSweepEvent;
    const sweptPriorDayLevel = sweep && sweep.eventType === "SWEEP" && sweep.barIndex === currentIndex
      ? sweep.levelType
      : undefined;
    const struct = this.structTracker.processCandle(candles, currentIndex, sweptPriorDayLevel);
    if (struct.lastEvent !== null) this.lastConfirmedStructureEvent = struct.lastEvent;
    // Independent of structure: CISD is candle-to-candle delivery, not swing-pivot driven. See
    // cisd.ts's own docstring for why it is not folded into the structure tracker.
    const cisdEvent = this.cisdTracker.processCandle(candles, currentIndex);
    if (cisdEvent !== null) this.lastCisdEvent = cisdEvent;
    // Reads the same confirmed-pivot stream `struct` was just derived from, transiently -- see
    // `confirmedPivotsView()`'s own "use it and drop it" rule, followed here exactly as the
    // liquidity resolver below already does with the same accessor.
    const swingHierarchy = computeSwingHierarchySnapshot(this.structTracker.confirmedPivotsView());
    const zones = this.zoneLedger.processCandle(candles, currentIndex, struct);
    // htfBias is the bias SOURCE, not a separate confirmation of it. See bias.ts.
    const bias = this.biasTracker.processCandle(candles, currentIndex, struct, sessionLevels, this.config.biasSource, htfBias, this.profile);

    // HTF bias is a separate (fractal) pillar. It is carried alongside the local
    // bias and never overwrites its value: overwriting left the reason codes
    // describing the opposite direction from the reported bias. Directional
    // alignment between the two is enforced downstream in the strategy gate.
    const liquidity = this.liquidityResolver.resolve(
      current.close,
      bias,
      struct,
      zones,
      sessionLevels,
      this.structTracker.confirmedPivotsView()
    );

    /*
     * Shadow-only: computeDrawOnLiquidity's own target selection, observed alongside `liquidity`
     * but feeding nothing and fed nothing by it. See `drawOnLiquidityState`'s docstring on
     * `IctStateCompositeSnapshot` for why this exists and why it is NOT wired into any gate.
     *
     * Pools come from the exact same `buildIctLiquidityPools` call `liquidityResolver.resolve()`
     * makes internally (computed a second time here, independently -- see that function's own
     * docstring for why duplicating the CALL, not the LOGIC, is the safe way to give a second
     * consumer the identical pool catalog).
     */
    const { erlPools, irlPools } = buildIctLiquidityPools(
      current.close,
      struct,
      zones,
      sessionLevels,
      this.structTracker.confirmedPivotsView()
    );
    const atr14 = this.atrTracker.processCandle(current);
    const htfDirection: -1 | 0 | 1 = htfBias === "BULLISH" ? 1 : htfBias === "BEARISH" ? -1 : 0;
    const drawOnLiquidity = computeDrawOnLiquidity(
      [...erlPools, ...irlPools],
      current.openTime.getTime(),
      current.close,
      atr14 ?? 0, // computeDrawOnLiquidity itself falls back to an effective ATR of 1 when <= 0
      htfDirection,
      current.close >= current.open
    );
    const drawOnLiquidityState: DrawOnLiquidityObservation = {
      selectedPool: drawOnLiquidity.selectedPool ?? null,
      candidatePoolCount: drawOnLiquidity.candidatePools.length,
      direction: drawOnLiquidity.direction ?? 0,
      selectionRuleVersion: drawOnLiquidity.selectionRuleVersion,
    };

    // Coverage is evidence sufficiency, carried independently of directional
    // value (invariant: UNKNOWN != NEUTRAL). NEUTRAL is a value the engine
    // reached on sufficient evidence and stays COMPLETE so it can reach the
    // gate; only absent/incomplete/ambiguous evidence is UNKNOWN/NOT_COVERED.
    const structureWarmed = struct.confirmedPivotCount > 0;
    const coverage: PillarCoverage = {
      structure: structureWarmed ? "COMPLETE" : "UNKNOWN",
      zones: currentIndex >= 2 ? "COMPLETE" : "UNKNOWN",
      sessionLevels: sessionLevels.levels !== null ? "COMPLETE" : "NOT_COVERED",
      bias: bias.bias !== "UNKNOWN" ? "COMPLETE" : "UNKNOWN",
      liquidity: liquidity.primaryTarget !== null ? "COMPLETE" : "NOT_COVERED",
      htf:
        htfBias === undefined
          ? "NOT_COVERED"
          : htfBias === "UNKNOWN"
            ? "UNKNOWN"
            : "COMPLETE",
    };

    return {
      engineVersion: ICT_STATE_ENGINE_VERSION,
      configHash: this.configHash,
      barIndex: currentIndex,
      barTime: current.openTime,
      structure: struct,
      swingHierarchy,
      cisd: this.lastCisdEvent,
      lastConfirmedStructureEvent: this.lastConfirmedStructureEvent,
      balancedPriceRanges: computeBalancedPriceRanges(zones.activeFvgs),
      zones,
      sessionLevels,
      bias,
      liquidity,
      htfBias: htfBias ?? null,
      coverage,
      drawOnLiquidityState,
      atr14,
    };
  }
}
