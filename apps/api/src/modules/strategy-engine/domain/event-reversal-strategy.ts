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
      // `IctLiquiditySnapshot` no longer carries a list of pool sweeps (pruned for memory reasons --
      // see that type's own docstring). The only currently-tracked "a session extreme was just swept"
      // signal is `sessionLevels.lastSweepEvent` (PDH/PDL only; weekly/4H/swing-high sweeps are not
      // wired into any snapshot today), the same field `bias.ts` reads for its own sweep-driven bias.
      const lastSweep = snapshot.sessionLevels?.lastSweepEvent;
      if (lastSweep && lastSweep.eventType === "SWEEP") {
        if (lastSweep.levelType === "PDH") {
          isHtfBearishSweep = true;
        } else if (lastSweep.levelType === "PDL") {
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
      // `CisdEvent` carries no `ageBars` field. Per `IctStateCompositeSnapshot.cisd`'s own docstring,
      // a consumer computes age from `confirmingCandleIndex` against the current bar.
      if (!cisd || snapshot.barIndex - cisd.confirmingCandleIndex > config.maxCisdAgeBars) {
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
