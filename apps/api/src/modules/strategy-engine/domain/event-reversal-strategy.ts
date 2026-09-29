import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
  TradeSide,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";

export interface EventReversalStrategyConfiguration {
  minimumRiskReward: number;
  minConfidence: number;
  expiryCandles: number;
  requireHtfSweep: boolean;
  requireCisdConfirmation: boolean;
  maxCisdAgeBars: number;
}

export const defaultEventReversalStrategyConfiguration: EventReversalStrategyConfiguration = {
  minimumRiskReward: 2.5,
  minConfidence: 0.75,
  expiryCandles: 24,
  requireHtfSweep: true,
  requireCisdConfirmation: true,
  maxCisdAgeBars: 10,
};

export const EVENT_REVERSAL_STRATEGY_KEY = "event-reversal-v1";

export const eventReversalStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: EVENT_REVERSAL_STRATEGY_KEY,
  version: 1,
  name: "Macro Event Reversal Strategy",
  description:
    "Trades major HTF liquidity reversals (Daily/Weekly/4H extremes) when swept and confirmed by LTF CISD delivery shift.",
  configuration: defaultEventReversalStrategyConfiguration as unknown as Record<string, unknown>,
  parametersSchema: {
    type: "object",
    properties: {
      minimumRiskReward: { type: "number", default: 2.5 },
      minConfidence: { type: "number", default: 0.75 },
      expiryCandles: { type: "number", default: 24 },
      requireHtfSweep: { type: "boolean", default: true },
      requireCisdConfirmation: { type: "boolean", default: true },
      maxCisdAgeBars: { type: "number", default: 10 },
    },
    required: [
      "minimumRiskReward",
      "minConfidence",
      "expiryCandles",
      "requireHtfSweep",
      "requireCisdConfirmation",
      "maxCisdAgeBars",
    ],
  },
  status: "ACTIVE",
};

export class EventReversalStrategy implements StrategyEvaluator {
  evaluate(context: StrategyMarketContext, rawConfig: Record<string, unknown>): ProposedTradeIdea[] {
    const config: EventReversalStrategyConfiguration = {
      ...defaultEventReversalStrategyConfiguration,
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

    // 1. Check for HTF Liquidity Pool Sweep
    let isHtfBullishSweep = false;
    let isHtfBearishSweep = false;

    if (config.requireHtfSweep) {
      const htfSweeps = snapshot.liquidity?.unmitigatedSweeps ?? [];
      if (htfSweeps.length > 0) {
        const lastSweep = htfSweeps[htfSweeps.length - 1];
        if (lastSweep.levelType === "PDH" || lastSweep.levelType === "PWH" || lastSweep.levelType === "SWING_HIGH") {
          isHtfBearishSweep = true;
        } else if (lastSweep.levelType === "PDL" || lastSweep.levelType === "PWL" || lastSweep.levelType === "SWING_LOW") {
          isHtfBullishSweep = true;
        }
      }
    }

    if (!isHtfBullishSweep && !isHtfBearishSweep) {
      return proposals;
    }

    // 2. Check for LTF CISD Confirmation
    if (config.requireCisdConfirmation) {
      const cisd = snapshot.cisd;
      if (!cisd || cisd.ageBars > config.maxCisdAgeBars) {
        return proposals;
      }
      if (isHtfBullishSweep && cisd.direction !== "BULLISH") {
        return proposals;
      }
      if (isHtfBearishSweep && cisd.direction !== "BEARISH") {
        return proposals;
      }
    }

    const side: TradeSide = isHtfBullishSweep ? "LONG" : "SHORT";
    const atrObj = context.indicators?.find((i) => i.code === "ATR");
    const atrValue = (atrObj?.values?.value as number) ?? Math.max(candle.high - candle.low, 10.0);
    const stopDistance = Math.max(atrValue * 1.5, 10.0);

    const entryPrice = candle.close;
    const stopLoss = isHtfBullishSweep ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = isHtfBullishSweep
      ? entryPrice + stopDistance * config.minimumRiskReward
      : entryPrice - stopDistance * config.minimumRiskReward;

    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(targetPrice - entryPrice);
    const riskReward = Number((reward / risk).toFixed(2));

    const evidenceItems: TradeIdeaEvidence[] = [
      {
        sourceType: "STRATEGY",
        sourceReference: "EVENT_REV_01",
        label: `Macro Event Reversal ${side} Signal`,
        contribution: 0.5,
        details: {
          requireHtfSweep: config.requireHtfSweep,
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
        `EVENT-REV-01: ${side} signal from macro HTF pool sweep confirmed by CISD reversal trigger.`,
      ],
      evidence: {
        strategy: EVENT_REVERSAL_STRATEGY_KEY,
        cisdDirection: snapshot.cisd?.direction,
      },
      expiresAt,
      evidenceItems,
    });

    return proposals;
  }
}
