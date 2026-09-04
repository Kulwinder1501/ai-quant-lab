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
      config.obMeanThresholdFraction
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
    const struct = this.structTracker.processCandle(candles, currentIndex);
    const zones = this.zoneLedger.processCandle(candles, currentIndex, struct);
    const sessionLevels = this.sessionTracker.processCandle(candles, currentIndex);
    const bias = this.biasTracker.processCandle(candles, currentIndex, struct, sessionLevels);

    // HTF bias is a separate (fractal) pillar. It is carried alongside the local
    // bias and never overwrites its value: overwriting left the reason codes
    // describing the opposite direction from the reported bias. Directional
    // alignment between the two is enforced downstream in the strategy gate.
    const liquidity = this.liquidityResolver.resolve(
      current.close,
      bias,
      struct,
      zones,
      sessionLevels
    );

    // Coverage is evidence sufficiency, carried independently of directional
    // value (invariant: UNKNOWN != NEUTRAL). NEUTRAL is a value the engine
    // reached on sufficient evidence and stays COMPLETE so it can reach the
    // gate; only absent/incomplete/ambiguous evidence is UNKNOWN/NOT_COVERED.
    const structureWarmed = struct.confirmedPivots.length > 0;
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
