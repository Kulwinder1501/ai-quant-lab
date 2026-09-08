import type { CausalCandle } from "./causal-pivot.js";
import {
  ICT_STATE_ENGINE_VERSION,
  computeIctConfigHash,
  defaultIctEngineConfig,
  type IctEngineConfig,
  type IctStateCompositeSnapshot,
  type PillarCoverage,
} from "./config.js";
import { IctStructureTracker } from "./structure.js";
import { IctZoneLedger } from "./zones.js";
import { IctSessionLevelTracker } from "./session-levels.js";
import { IctBiasTracker, type IctBiasDirection } from "./bias.js";
import { IctLiquidityResolver } from "./liquidity.js";

export class IctCompositeEngine {
  private readonly structTracker: IctStructureTracker;
  private readonly zoneLedger: IctZoneLedger;
  private readonly sessionTracker: IctSessionLevelTracker;
  private readonly biasTracker: IctBiasTracker;
  private readonly liquidityResolver: IctLiquidityResolver;
  private readonly configHash: string;

  constructor(private readonly config: IctEngineConfig = defaultIctEngineConfig) {
    this.structTracker = new IctStructureTracker(config.pivotLength);
    this.zoneLedger = new IctZoneLedger(
      config.obDisplacementBodyAtrMultiple,
      config.obMeanThresholdFraction,
      config.invertedBlocksRemainPoi
    );
    this.sessionTracker = new IctSessionLevelTracker();
    this.biasTracker = new IctBiasTracker();
    this.liquidityResolver = new IctLiquidityResolver();
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
    const zones = this.zoneLedger.processCandle(candles, currentIndex, struct);
    // htfBias is the bias SOURCE, not a separate confirmation of it. See bias.ts.
    const bias = this.biasTracker.processCandle(candles, currentIndex, struct, sessionLevels, this.config.biasSource, htfBias);

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
      zones,
      sessionLevels,
      bias,
      liquidity,
      htfBias: htfBias ?? null,
      coverage,
    };
  }
}
