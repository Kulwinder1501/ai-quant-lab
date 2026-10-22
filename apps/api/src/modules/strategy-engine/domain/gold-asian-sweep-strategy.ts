import {
  type EnsureStrategyVersionInput,
  type ProposedTradeIdea,
  type StrategyMarketContext,
  type TradeIdeaEvidence,
  type TradeSide,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";
import {
  AsianSessionRangeTracker,
  type AsianSessionTrackerConfig,
  defaultAsianSessionConfig,
} from "../../technical-analysis/domain/ict/asian-session.js";

export const GOLD_ASIAN_SWEEP_STRATEGY_KEY = "gold-asian-sweep-v1";

export interface GoldAsianSweepStrategyConfig extends AsianSessionTrackerConfig {
  stopBuffer: number; // 0.40 USD buffer outside sweep extreme
  targetR: number; // 1.5R default target
  confidence: number; // 0.75
  expiryCandles: number; // 4
}

export const defaultGoldAsianSweepConfig: GoldAsianSweepStrategyConfig = {
  ...defaultAsianSessionConfig,
  stopBuffer: 0.40,
  targetR: 1.5,
  confidence: 0.75,
  expiryCandles: 4,
};

export const goldAsianSweepStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: GOLD_ASIAN_SWEEP_STRATEGY_KEY,
  name: "Gold Asian Session Sweep",
  description:
    "Trades London-session liquidity sweeps and reclaims of the Asian session high/low on XAU/USD. "
    + "Enforces strict range validity, penetration bounds, and rejection wicks.",
  version: 1,
  configuration: defaultGoldAsianSweepConfig as unknown as Record<string, unknown>,
};

export class GoldAsianSweepStrategy implements StrategyEvaluator {
  private readonly tracker: AsianSessionRangeTracker;

  constructor(private readonly config: GoldAsianSweepStrategyConfig = defaultGoldAsianSweepConfig) {
    this.tracker = new AsianSessionRangeTracker(config);
  }

  evaluate(
    context: StrategyMarketContext,
    strategyConfiguration: Record<string, unknown> = {}
  ): ProposedTradeIdea[] {
    const config: GoldAsianSweepStrategyConfig = {
      ...this.config,
      ...strategyConfiguration,
    };

    const candle = context.candle;
    const snapshot = this.tracker.processCandle(candle);

    if (!snapshot.sweepEvent || !snapshot.isValid) {
      return [];
    }

    const sweep = snapshot.sweepEvent;
    const isBullish = sweep.type === "BULLISH_SWEEP";
    const side: TradeSide = isBullish ? "LONG" : "SHORT";
    const entryPrice = candle.close;

    let stopLoss: number;
    let targetPrice: number;
    let riskDistance: number;

    if (isBullish) {
      stopLoss = Number((sweep.sweepExtreme - config.stopBuffer).toFixed(2));
      riskDistance = entryPrice - stopLoss;
      if (riskDistance <= 0.20 || riskDistance > 15.0) return [];
      targetPrice = Number((entryPrice + riskDistance * config.targetR).toFixed(2));
    } else {
      stopLoss = Number((sweep.sweepExtreme + config.stopBuffer).toFixed(2));
      riskDistance = stopLoss - entryPrice;
      if (riskDistance <= 0.20 || riskDistance > 15.0) return [];
      targetPrice = Number((entryPrice - riskDistance * config.targetR).toFixed(2));
    }

    const candleDurationMs = candle.closeTime.getTime() - candle.openTime.getTime();
    const expiresAt = new Date(candle.closeTime.getTime() + config.expiryCandles * candleDurationMs);

    const evidence: TradeIdeaEvidence[] = [
      {
        source: "STRATEGY",
        description: `${sweep.type} of Asian ${isBullish ? "Low" : "High"} at ${sweep.level.toFixed(2)} (penetration ${sweep.penetrationBps} bps, wick ${Math.round(sweep.rejectionWickPct * 100)}%)`,
        confidence: config.confidence,
        data: {
          asianHigh: snapshot.asiaHigh,
          asianLow: snapshot.asiaLow,
          asianRangeBps: snapshot.asiaRangeBps,
          asianMidpoint: snapshot.midpoint,
          sweepExtreme: sweep.sweepExtreme,
          penetrationBps: sweep.penetrationBps,
          reclaimBps: sweep.reclaimBps,
          rejectionWickPct: sweep.rejectionWickPct,
        },
      },
    ];

    const proposal: ProposedTradeIdea = {
      side,
      entryPrice,
      stopLoss,
      targetPrice,
      riskReward: config.targetR,
      confidence: config.confidence,
      reasoning: {
        strategy: GOLD_ASIAN_SWEEP_STRATEGY_KEY,
        sweepType: sweep.type,
        asianHigh: snapshot.asiaHigh,
        asianLow: snapshot.asiaLow,
        asianMidpoint: snapshot.midpoint,
        sweepLevel: sweep.level,
        sweepExtreme: sweep.sweepExtreme,
        penetrationBps: sweep.penetrationBps,
        rejectionWickPct: sweep.rejectionWickPct,
      },
      evidence,
      expiresAt,
    };

    return [proposal];
  }
}
