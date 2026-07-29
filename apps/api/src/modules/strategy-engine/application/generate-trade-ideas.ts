import {
  type StrategyMarketContextRepository,
  type StrategyVersionRepository,
  type TradeIdeaRepository,
} from "../domain/strategy.js";
import { TrendBreakoutStrategy, trendBreakoutStrategyRegistration } from "../domain/trend-breakout-strategy.js";

export interface GenerateTradeIdeasInput {
  instrumentId: string;
  timeframe: string;
}

export interface GenerateTradeIdeasResult {
  strategyVersionId: string;
  sourceCandleId: string | null;
  candidatesGenerated: number;
  tradeIdeaIds: string[];
  skippedReason: "NO_COMPLETED_CANDLE" | "STRATEGY_INACTIVE" | "RULES_NOT_MET" | null;
}

/**
 * Evaluates the latest completed candle only. The resulting idea is a research
 * proposal created after the candle close, never an order or a simulated fill.
 */
export class GenerateTradeIdeas {
  constructor(
    private readonly strategyVersionRepository: StrategyVersionRepository,
    private readonly marketContextRepository: StrategyMarketContextRepository,
    private readonly tradeIdeaRepository: TradeIdeaRepository,
    private readonly strategy = new TrendBreakoutStrategy(),
  ) {}

  async execute(input: GenerateTradeIdeasInput): Promise<GenerateTradeIdeasResult> {
    const strategyVersion = await this.strategyVersionRepository.ensure(trendBreakoutStrategyRegistration);
    if (strategyVersion.isArchived || !strategyVersion.isActive) {
      return {
        strategyVersionId: strategyVersion.id,
        sourceCandleId: null,
        candidatesGenerated: 0,
        tradeIdeaIds: [],
        skippedReason: "STRATEGY_INACTIVE",
      };
    }

    const context = await this.marketContextRepository.findLatestCompleted(input);
    if (!context) {
      return {
        strategyVersionId: strategyVersion.id,
        sourceCandleId: null,
        candidatesGenerated: 0,
        tradeIdeaIds: [],
        skippedReason: "NO_COMPLETED_CANDLE",
      };
    }

    const proposals = this.strategy.evaluate(context, strategyVersion.configuration);
    const tradeIdeas = await Promise.all(proposals.map((proposal) => this.tradeIdeaRepository.saveProposal({
      ...proposal,
      instrumentId: input.instrumentId,
      strategyVersionId: strategyVersion.id,
      sourceCandleId: context.candle.id,
    })));

    return {
      strategyVersionId: strategyVersion.id,
      sourceCandleId: context.candle.id,
      candidatesGenerated: proposals.length,
      tradeIdeaIds: tradeIdeas.map((idea) => idea.id),
      skippedReason: proposals.length === 0 ? "RULES_NOT_MET" : null,
    };
  }
}
