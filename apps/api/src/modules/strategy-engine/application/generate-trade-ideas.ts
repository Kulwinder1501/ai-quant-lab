import type {
  StrategyMarketContextRepository,
  StrategyVersionRepository,
  TradeIdeaRepository,
  TradeSide,
} from "../domain/strategy.js";
import { registeredStrategies, strategySupportsTimeframe } from "../domain/strategy-registry.js";
import { applySmcConfluenceToProposal } from "../domain/smc-confluence.js";

export interface GenerateTradeIdeasInput {
  instrumentId: string;
  timeframe: string;
  allowedSides?: readonly TradeSide[];
}

export interface GenerateTradeIdeasResult {
  strategyVersionId: string | null;
  strategyKey: string;
  sourceCandleId: string | null;
  candidatesGenerated: number;
  tradeIdeaIds: string[];
  skippedReason: "NO_COMPLETED_CANDLE" | "STRATEGY_INACTIVE" | "RULES_NOT_MET" | "STRATEGY_FAILED" | "TIMEFRAME_UNSUPPORTED" | null;
  /** Present only when skippedReason is STRATEGY_FAILED. */
  failureMessage?: string;
}

export interface ScanTradeIdeasInput {
  instrumentId: string;
  timeframe: string;
  allowedSides?: readonly TradeSide[];
  /** How many of the most recent completed candles to evaluate. */
  lookback: number;
}

export interface ScanTradeIdeasResult {
  strategyVersionId: string | null;
  strategyKey: string;
  contextsScanned: number;
  candidatesGenerated: number;
  /** Direction breakdown so a caller can see at a glance that shorts were found. */
  longIdeas: number;
  shortIdeas: number;
  tradeIdeaIds: string[];
  skippedReason: "NO_COMPLETED_CANDLE" | "STRATEGY_INACTIVE" | "RULES_NOT_MET" | "STRATEGY_FAILED" | "TIMEFRAME_UNSUPPORTED" | null;
  failureMessage?: string;
}

const STRATEGIES = registeredStrategies;

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

    for (const strategyEntry of STRATEGIES) {
      const { registration, StrategyClass } = strategyEntry;
      // Each strategy is isolated. Without this, one strategy whose registered
      // configuration fails its own parser rejects the whole call *after* an
      // earlier strategy has already persisted its proposals, so the caller sees
      // a failure for a run that committed rows.
      try {
        if (!strategySupportsTimeframe(strategyEntry, input.timeframe)) {
          results.push({
            strategyVersionId: null,
            strategyKey: registration.strategyKey,
            sourceCandleId: null,
            candidatesGenerated: 0,
            tradeIdeaIds: [],
            skippedReason: "TIMEFRAME_UNSUPPORTED",
          });
          continue;
        }

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
        let proposals = strategy.evaluate(context, strategyVersion.configuration)
          .map((proposal) => applySmcConfluenceToProposal(context, proposal));
        if (input.allowedSides) {
          proposals = proposals.filter((proposal) => input.allowedSides!.includes(proposal.side));
        }
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

  /**
   * Evaluates a window of the most recent completed candles instead of only the
   * latest one, persisting every proposal each bar produces.
   *
   * This is the historical-scan counterpart to `execute`. `execute` is a
   * point-in-time proposal made right after the latest bar closes, so it emits a
   * SHORT only when that single bar is bearish; a research user asking "does the
   * strategy find puts?" needs to see the bearish setups that have already closed.
   * The default single-candle behaviour is deliberately left untouched — this is
   * an explicit, opt-in path.
   */
  async executeScan(input: ScanTradeIdeasInput): Promise<ScanTradeIdeasResult[]> {
    const contexts = await this.marketContextRepository.listCompletedContexts({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      limit: Math.max(1, Math.floor(input.lookback)),
    });
    const results: ScanTradeIdeasResult[] = [];

    for (const strategyEntry of STRATEGIES) {
      const { registration, StrategyClass } = strategyEntry;
      // Each strategy stays isolated for the same reason execute() isolates them:
      // one strategy that cannot parse its own configuration must not discard
      // proposals another has already persisted.
      try {
        if (!strategySupportsTimeframe(strategyEntry, input.timeframe)) {
          results.push({
            strategyVersionId: null,
            strategyKey: registration.strategyKey,
            contextsScanned: contexts.length,
            candidatesGenerated: 0,
            longIdeas: 0,
            shortIdeas: 0,
            tradeIdeaIds: [],
            skippedReason: "TIMEFRAME_UNSUPPORTED",
          });
          continue;
        }

        const strategyVersion = await this.strategyVersionRepository.ensure(registration);
        if (strategyVersion.isArchived || !strategyVersion.isActive) {
          results.push({
            strategyVersionId: strategyVersion.id,
            strategyKey: registration.strategyKey,
            contextsScanned: contexts.length,
            candidatesGenerated: 0,
            longIdeas: 0,
            shortIdeas: 0,
            tradeIdeaIds: [],
            skippedReason: "STRATEGY_INACTIVE",
          });
          continue;
        }

        if (contexts.length === 0) {
          results.push({
            strategyVersionId: strategyVersion.id,
            strategyKey: registration.strategyKey,
            contextsScanned: 0,
            candidatesGenerated: 0,
            longIdeas: 0,
            shortIdeas: 0,
            tradeIdeaIds: [],
            skippedReason: "NO_COMPLETED_CANDLE",
          });
          continue;
        }

        const strategy = new StrategyClass();
        const tradeIdeaIds: string[] = [];
        let longIdeas = 0;
        let shortIdeas = 0;

        for (const context of contexts) {
          let proposals = strategy.evaluate(context, strategyVersion.configuration)
            .map((proposal) => applySmcConfluenceToProposal(context, proposal));
          if (input.allowedSides) {
            proposals = proposals.filter((proposal) => input.allowedSides!.includes(proposal.side));
          }
          for (const proposal of proposals) {
            const idea = await this.tradeIdeaRepository.saveProposal({
              ...proposal,
              instrumentId: input.instrumentId,
              strategyVersionId: strategyVersion.id,
              sourceCandleId: context.candle.id,
            });
            tradeIdeaIds.push(idea.id);
            if (proposal.side === "SHORT") shortIdeas += 1;
            else longIdeas += 1;
          }
        }

        results.push({
          strategyVersionId: strategyVersion.id,
          strategyKey: registration.strategyKey,
          contextsScanned: contexts.length,
          candidatesGenerated: tradeIdeaIds.length,
          longIdeas,
          shortIdeas,
          tradeIdeaIds,
          skippedReason: tradeIdeaIds.length === 0 ? "RULES_NOT_MET" : null,
        });
      } catch (error) {
        results.push({
          strategyVersionId: null,
          strategyKey: registration.strategyKey,
          contextsScanned: contexts.length,
          candidatesGenerated: 0,
          longIdeas: 0,
          shortIdeas: 0,
          tradeIdeaIds: [],
          skippedReason: "STRATEGY_FAILED",
          failureMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
