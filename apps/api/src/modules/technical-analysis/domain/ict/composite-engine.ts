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

    // If HTF bias is provided, it can reinforce or override local bias
    const effectiveBias =
      htfBias && htfBias !== "UNKNOWN" && htfBias !== "NEUTRAL"
        ? { ...bias, bias: htfBias }
        : bias;

    const liquidity = this.liquidityResolver.resolve(
      current.close,
      effectiveBias,
      struct,
      zones,
      sessionLevels
    );

    const coverage: PillarCoverage = {
      structure: struct.trend !== "NEUTRAL" ? "COMPLETE" : "UNKNOWN",
      zones: "COMPLETE",
      sessionLevels: sessionLevels.levels !== null ? "COMPLETE" : "NOT_COVERED",
      bias:
        effectiveBias.bias !== "UNKNOWN" && effectiveBias.bias !== "NEUTRAL"
          ? "COMPLETE"
          : "UNKNOWN",
      liquidity: liquidity.primaryTarget !== null ? "COMPLETE" : "NOT_COVERED",
      htf: htfBias ? "COMPLETE" : "NOT_COVERED",
    };

    return {
      engineVersion: ICT_STATE_ENGINE_VERSION,
      configHash: this.configHash,
      barIndex: currentIndex,
      barTime: current.openTime,
      structure: struct,
      zones,
      sessionLevels,
      bias: effectiveBias,
      liquidity,
      coverage,
    };
  }
}
