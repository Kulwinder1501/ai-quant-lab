import {
  type StrategyMarketContextRepository,
  type StrategyVersionRepository,
  type TradeIdeaRepository,
} from "../domain/strategy.js";
import { TrendBreakoutStrategy, trendBreakoutStrategyRegistration } from "../domain/trend-breakout-strategy.js";

import { MomentumScalpStrategy, momentumScalpStrategyRegistration } from "../domain/momentum-scalp-strategy.js";

export interface GenerateTradeIdeasInput {
  instrumentId: string;
  timeframe: string;
}

export interface GenerateTradeIdeasResult {
  strategyVersionId: string | null;
  strategyKey: string;
  sourceCandleId: string | null;
  candidatesGenerated: number;
  tradeIdeaIds: string[];
  skippedReason: "NO_COMPLETED_CANDLE" | "STRATEGY_INACTIVE" | "RULES_NOT_MET" | "STRATEGY_FAILED" | null;
  /** Present only when skippedReason is STRATEGY_FAILED. */
  failureMessage?: string;
}

const STRATEGIES = [
  { registration: trendBreakoutStrategyRegistration, StrategyClass: TrendBreakoutStrategy },
  { registration: momentumScalpStrategyRegistration, StrategyClass: MomentumScalpStrategy },
];

/**
 * Evaluates the latest completed candle only. The resulting idea is a research
 * proposal created after the candle close, never an order or a simulated fill.
 */
export class GenerateTradeIdeas {
  constructor(
    private readonly strategyVersionRepository: StrategyVersionRepository,
    private readonly marketContextRepository: StrategyMarketContextRepository,
    private readonly tradeIdeaRepository: TradeIdeaRepository,
  ) {}

  async execute(input: GenerateTradeIdeasInput): Promise<GenerateTradeIdeasResult[]> {
    const context = await this.marketContextRepository.findLatestCompleted(input);
    const results: GenerateTradeIdeasResult[] = [];

    for (const { registration, StrategyClass } of STRATEGIES) {
      // Each strategy is isolated. Without this, one strategy whose registered
      // configuration fails its own parser rejects the whole call *after* an
      // earlier strategy has already persisted its proposals, so the caller sees
      // a failure for a run that committed rows.
      try {
        const strategyVersion = await this.strategyVersionRepository.ensure(registration);
        if (strategyVersion.isArchived || !strategyVersion.isActive) {
          results.push({
            strategyVersionId: strategyVersion.id,
            strategyKey: registration.strategyKey,
            sourceCandleId: null,
            candidatesGenerated: 0,
            tradeIdeaIds: [],
            skippedReason: "STRATEGY_INACTIVE",
          });
          continue;
        }

        if (!context) {
          results.push({
            strategyVersionId: strategyVersion.id,
            strategyKey: registration.strategyKey,
            sourceCandleId: null,
            candidatesGenerated: 0,
            tradeIdeaIds: [],
            skippedReason: "NO_COMPLETED_CANDLE",
          });
          continue;
        }

        const strategy = new StrategyClass();
        const proposals = strategy.evaluate(context, strategyVersion.configuration);
        const tradeIdeas = await Promise.all(proposals.map((proposal) => this.tradeIdeaRepository.saveProposal({
          ...proposal,
          instrumentId: input.instrumentId,
          strategyVersionId: strategyVersion.id,
          sourceCandleId: context.candle.id,
        })));

        results.push({
          strategyVersionId: strategyVersion.id,
          strategyKey: registration.strategyKey,
          sourceCandleId: context.candle.id,
          candidatesGenerated: proposals.length,
          tradeIdeaIds: tradeIdeas.map((idea) => idea.id),
          skippedReason: proposals.length === 0 ? "RULES_NOT_MET" : null,
        });
      } catch (error) {
        results.push({
          strategyVersionId: null,
          strategyKey: registration.strategyKey,
          sourceCandleId: context?.candle.id ?? null,
          candidatesGenerated: 0,
          tradeIdeaIds: [],
          skippedReason: "STRATEGY_FAILED",
          failureMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
