import type {
  StrategyMarketContext,
  StrategyMarketContextRepository,
  StrategyVersionRepository,
  TradeIdeaRepository,
  TradeSide,
} from "../domain/strategy.js";
import type { HistoricalTimeframe } from "../../market-data/domain/historical-data-provider.js";
import { isStrictlyHigherTimeframe } from "../domain/timeframe-order.js";
import type { RegimeContext } from "../domain/regime.js";
import {
  liveTradableStrategies,
  type RegisteredStrategy,
  strategyExecutableSides,
  strategySupportsTimeframe,
} from "../domain/strategy-registry.js";
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
  /**
   * The volatility regime carried by the evaluated bar, or null when it could not be measured.
   *
   * Surfaced because the context repository derives it per bar and every caller discarded it, so a
   * later "did this fire in HIGH_VOL?" could only be answered by re-deriving from series that get
   * backfilled and recomputed. Nothing in the generator reads it; it exists to be recorded.
   */
  regime: RegimeContext | null;
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

/*
 * Live idea generation, so terminal strategies are excluded here rather than at each call site.
 *
 * All three constructors of this service -- the paper bot, the manual CLI and the HTTP API -- produce
 * live proposals; none of them is a measurement path, which reaches strategies directly through
 * `requireRegisteredStrategy` instead. Filtering once here therefore covers every live consumer,
 * and a new one cannot forget to.
 */
/**
 * Evaluates the latest completed candle only. The resulting idea is a research
 * proposal created after the candle close, never an order or a simulated fill.
 */
export class GenerateTradeIdeas {
  constructor(
    private readonly strategyVersionRepository: StrategyVersionRepository,
    private readonly marketContextRepository: StrategyMarketContextRepository,
    private readonly tradeIdeaRepository: TradeIdeaRepository,
    /**
     * The strategies this instance may propose from. Defaults to the live-tradable set.
     *
     * It was a module-level constant, which made the ambient registry a hidden dependency of every
     * test: they had to reach for whichever real strategy happened to suit, and gating the live set
     * then broke four of them for a reason that had nothing to do with what they were testing.
     * Injectable, they say which strategy they exercise.
     */
    private readonly strategies: readonly RegisteredStrategy[] = liveTradableStrategies(),
  ) {}

  /**
   * Higher timeframes attached to every generated context, fastest first.
   *
   * Production has never populated `higherTimeframeContexts` -- only the research harness did, so
   * `calculateHtfTrendAlignment` scored 0 for every live signal and the confluence terms were
   * inert. This closes that gap. It is pure capability: nothing reads the field unless a strategy
   * opts in, so attaching it changes no existing behaviour.
   *
   * A timeframe is skipped rather than fatal when its bar is missing, which is the ordinary state
   * early in a session before the first slower bar has closed.
   */
  private static readonly HIGHER_TIMEFRAMES = ["5m", "15m"] as const;

  /**
   * Attaches the most recent *closed* slower bars to a context.
   *
   * The anti-lookahead guarantee is asserted here as well as enforced in SQL. That is deliberate
   * duplication: the repository's `close_time <= asOf` is the real guard, but a query regression
   * would otherwise leak an unclosed 15m bar into a 1m signal silently, and a leak of that shape
   * inflates every downstream result rather than failing loudly. The research harness repeats the
   * guard at its own attach site for the same reason.
   */
  private async withHigherTimeframes(context: StrategyMarketContext): Promise<StrategyMarketContext> {
    const fetch = this.marketContextRepository.findCompletedBefore?.bind(this.marketContextRepository);
    if (!fetch) return context;

    const asOf = context.candle.closeTime;
    const attached: Partial<Record<HistoricalTimeframe, StrategyMarketContext>> = {};
    for (const timeframe of GenerateTradeIdeas.HIGHER_TIMEFRAMES) {
      // Never attach a bar of the timeframe being evaluated, or a faster one: "higher" has to mean
      // higher, and a 5m signal must not receive a 5m "confluence" bar that is simply itself.
      if (!isStrictlyHigherTimeframe(context.candle.timeframe, timeframe)) continue;
      const htf = await fetch({ instrumentId: context.candle.instrumentId, timeframe, asOf });
      if (!htf) continue;
      if (htf.candle.closeTime.getTime() > asOf.getTime()) {
        throw new Error(
          `HTF_CONTEXT_LOOKAHEAD: ${timeframe} bar closed after the ${context.candle.timeframe} decision at ${asOf.toISOString()}.`,
        );
      }
      attached[timeframe] = htf;
    }
    return Object.keys(attached).length > 0 ? { ...context, higherTimeframeContexts: attached } : context;
  }

  async execute(input: GenerateTradeIdeasInput): Promise<GenerateTradeIdeasResult[]> {
    const latest = await this.marketContextRepository.findLatestCompleted(input);
    const context = latest ? await this.withHigherTimeframes(latest) : null;
    const results: GenerateTradeIdeasResult[] = [];

    for (const strategyEntry of this.strategies) {
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
            regime: context?.regime ?? null,
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
            regime: context?.regime ?? null,
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
            regime: null,
          });
          continue;
        }

        const strategy = new StrategyClass();
        const rawProposals = strategy.evaluate(context, strategyVersion.configuration);
        let proposals = registration.strategyKey === "ict-structure-v1"
          ? rawProposals
          : rawProposals.map((proposal) => applySmcConfluenceToProposal(context, proposal));
        /*
         * The strategy's own declared sides first, then the caller's optional narrowing.
         *
         * Per strategy rather than per run: the evidence for restricting a side is measured on one
         * strategy, and a global `allowedSides` would silence that side across every strategy here.
         * Filtering at generation is safe for measurement because the research harness evaluates its
         * own frozen copies ungated and captures every bar, so the suppressed population stays
         * observable in `research_scalp`.
         */
        proposals = proposals.filter((proposal) =>
          strategyExecutableSides(strategyEntry).includes(proposal.side));
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
          regime: context.regime ?? null,
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
          regime: context?.regime ?? null,
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
    const scanned = await this.marketContextRepository.listCompletedContexts({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      limit: Math.max(1, Math.floor(input.lookback)),
    });
    // Each scanned bar gets the slower bars that had closed *by that bar*, not by now. Attaching
    // the current higher-timeframe state to a historical bar would be lookahead of exactly the
    // kind the assert above exists to catch, and it would quietly flatter any backfilled scan.
    const contexts: StrategyMarketContext[] = [];
    for (const context of scanned) contexts.push(await this.withHigherTimeframes(context));
    const results: ScanTradeIdeasResult[] = [];

    for (const strategyEntry of this.strategies) {
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
          const rawProposals = strategy.evaluate(context, strategyVersion.configuration);
          let proposals = registration.strategyKey === "ict-structure-v1"
            ? rawProposals
            : rawProposals.map((proposal) => applySmcConfluenceToProposal(context, proposal));
          // Same rule as generation, so a scan cannot report candidates on a side production
          // would refuse to trade.
          proposals = proposals.filter((proposal) =>
            strategyExecutableSides(strategyEntry).includes(proposal.side));
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
