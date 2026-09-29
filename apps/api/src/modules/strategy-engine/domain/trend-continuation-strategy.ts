import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
  TradeSide,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";
import { computeSwingHierarchyFeature } from "../../technical-analysis/domain/ict/swing-hierarchy.js";

export interface TrendContinuationStrategyConfiguration {
  minimumRiskReward: number;
  minConfidence: number;
  expiryCandles: number;
  requireProtectedLevelIntact: boolean;
  requireMinorSweep: boolean;
  requireCisdConfirmation: boolean;
  maxCisdAgeBars: number;
}

export const defaultTrendContinuationStrategyConfiguration: TrendContinuationStrategyConfiguration = {
  minimumRiskReward: 1.5,
  minConfidence: 0.7,
  expiryCandles: 12,
  requireProtectedLevelIntact: true,
  requireMinorSweep: true,
  requireCisdConfirmation: true,
  maxCisdAgeBars: 10,
};

export const TREND_CONTINUATION_STRATEGY_KEY = "trend-continuation-v1";

export const trendContinuationStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: TREND_CONTINUATION_STRATEGY_KEY,
  version: 1,
  name: "Micro Timeframe Trend Continuation Strategy",
  description:
    "Trades lower timeframe trend continuation following a minor liquidity sweep while the major swing protected level stays intact, confirmed by CISD.",
  configuration: defaultTrendContinuationStrategyConfiguration as unknown as Record<string, unknown>,
};

export class TrendContinuationStrategy implements StrategyEvaluator {
  evaluate(context: StrategyMarketContext, rawConfig: Record<string, unknown>): ProposedTradeIdea[] {
    const config: TrendContinuationStrategyConfiguration = {
      ...defaultTrendContinuationStrategyConfiguration,
      ...rawConfig,
    };

    const proposals: ProposedTradeIdea[] = [];
    const candle = context.candle;
    if (!candle) {
      return proposals;
    }

    const snapshot = context.ictSnapshot;
    if (!snapshot) {
      return proposals;
    }

    // 1. Determine Trend Direction from ICT Structure / Bias
    const trend = snapshot.structure?.trend ?? "NEUTRAL";
    const isBullishTrend = trend === "BULLISH";
    const isBearishTrend = trend === "BEARISH";

    if (!isBullishTrend && !isBearishTrend) {
      return proposals;
    }

    // 2. Protected Level Gate via Swing Hierarchy
    const swingHierarchy = snapshot.swingHierarchy;
    if (config.requireProtectedLevelIntact && swingHierarchy) {
      const feature = computeSwingHierarchyFeature(swingHierarchy, trend, candle.close);
      if (feature.protectedLevelBreached) {
        return proposals; // Level breached -> trend continuation invalidated
      }
    }

    // 3. Minor Liquidity Sweep Gate
    if (config.requireMinorSweep && swingHierarchy) {
      const minorHigh = swingHierarchy.nearestShortTermHigh;
      const minorLow = swingHierarchy.nearestShortTermLow;
      if (isBullishTrend && minorLow && candle.low > minorLow.price) {
        return proposals;
      }
      if (isBearishTrend && minorHigh && candle.high < minorHigh.price) {
        return proposals;
      }
    }

    // 4. CISD Confirmation Gate
    if (config.requireCisdConfirmation) {
      const cisd = snapshot.cisd;
      // `CisdEvent` carries no `ageBars` field. Per `IctStateCompositeSnapshot.cisd`'s own docstring,
      // a consumer computes age from `confirmingCandleIndex` against the current bar.
      if (!cisd || snapshot.barIndex - cisd.confirmingCandleIndex > config.maxCisdAgeBars) {
        return proposals;
      }
      if (isBullishTrend && cisd.direction !== "BULLISH") {
        return proposals;
      }
      if (isBearishTrend && cisd.direction !== "BEARISH") {
        return proposals;
      }
    }

    const side: TradeSide = isBullishTrend ? "LONG" : "SHORT";
    const atrObj = context.indicators?.find((i) => i.code === "ATR");
    const atrValue = (atrObj?.values?.value as number) ?? Math.max(candle.high - candle.low, 5.0);
    const stopDistance = Math.max(atrValue * 1.2, 5.0);

    const entryPrice = candle.close;
    const stopLoss = isBullishTrend ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = isBullishTrend
      ? entryPrice + stopDistance * config.minimumRiskReward
      : entryPrice - stopDistance * config.minimumRiskReward;

    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(targetPrice - entryPrice);
    const riskReward = Number((reward / risk).toFixed(2));

    const evidenceItems: TradeIdeaEvidence[] = [
      {
        sourceType: "STRATEGY",
        sourceReference: "TREND_CONT_01",
        label: `Trend Continuation ${side} Alignment`,
        contribution: 0.5,
        details: {
          trend,
          requireProtectedLevelIntact: config.requireProtectedLevelIntact,
          cisdDirection: snapshot.cisd?.direction ?? "N/A",
        },
      },
    ];

    const expiresAt = new Date(candle.closeTime.getTime() + config.expiryCandles * 5 * 60_000);

    proposals.push({
      side,
      entryPrice,
      stopLoss,
      targetPrice,
      riskReward,
      confidence: config.minConfidence,
      reasoning: [
        `TREND-CONT-01: ${side} signal aligned with structure trend ${trend} and intact protected level.`,
      ],
      evidence: {
        strategy: TREND_CONTINUATION_STRATEGY_KEY,
        trend,
        cisdDirection: snapshot.cisd?.direction,
      },
      expiresAt,
      evidenceItems,
    });

    return proposals;
  }
}
