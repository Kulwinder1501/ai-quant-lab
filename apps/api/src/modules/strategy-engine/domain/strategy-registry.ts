import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeSide,
} from "./strategy.js";
import { MomentumScalpStrategy, momentumScalpStrategyRegistration } from "./momentum-scalp-strategy.js";
import { MomentumScalpIndexStrategy, momentumScalpIndexStrategyRegistration } from "./momentum-scalp-index-strategy.js";
import {
  MomentumScalpPatternStrategy,
  MomentumScalpPatternStrategyV2,
  momentumScalpPatternStrategyRegistration,
  momentumScalpPatternStrategyV2Registration,
} from "./momentum-scalp-pattern-strategy.js";
import { TrendBreakoutStrategy, trendBreakoutStrategyRegistration } from "./trend-breakout-strategy.js";

/** What every strategy implementation must offer to a caller that replays candles. */
export interface StrategyEvaluator {
  evaluate(context: StrategyMarketContext, strategyConfiguration: Record<string, unknown>): ProposedTradeIdea[];
}

export interface RegisteredStrategy {
  registration: EnsureStrategyVersionInput;
  StrategyClass: new () => StrategyEvaluator;
  /**
   * The timeframes whose bar geometry the rule thresholds were calibrated against.
   *
   * Rule thresholds are not scale-free. momentum-scalp bounds RSI to a 20-40 /
   * 60-80 band and measures VWAP displacement in ATR units of a one-minute bar;
   * run against a daily bar it still emits proposals, but they are day-sized
   * moves wearing a scalp's label, and VWAP on a daily candle is meaningless.
   * Generation therefore asks each strategy whether it owns the timeframe rather
   * than running every registered strategy against whatever was requested.
   */
  supportedTimeframes: readonly string[];
  /**
   * The sides this strategy is permitted to trade, or absent for both.
   *
   * A side-specific measurement, kept beside the strategy rather than in a caller, because a global
   * `allowedSides` on the generator would silence the same side across every strategy in the run --
   * and the evidence is per strategy, not per system.
   *
   * Restricting a side does **not** hide it from measurement. The research harness evaluates its own
   * frozen copies of these strategies with their gates lifted (`minimumConfidence: 0`) and captures
   * every eligible bar, so the suppressed population stays fully observable in `research_scalp` and
   * the restriction can be re-measured against it later. That separation is why this can filter at
   * generation instead of having to record a refusal per idea.
   */
  executableSides?: readonly TradeSide[];
  /**
   * Required when this strategy's research twin has been closed as TERMINAL and it is still enabled.
   *
   * The governance gap this closes, found 2026-09-02: the research harness had recorded
   * `index-v3-research` and `pattern-v4-research` as TERMINAL / NEVER_ELIGIBLE, and both of their
   * operational twins were live and trading, with nothing connecting the two records. The verdict
   * was written down and propagated nowhere.
   *
   * It is an acknowledgement rather than an automatic disable, deliberately. A research TERMINAL is a
   * verdict on a measured line of inquiry under the harness's canonical geometry; whether the live
   * strategy should keep trading is a separate decision with its own evidence, and having a research
   * conclusion silently close a production strategy would be as wrong in the other direction. What
   * must not happen is the verdict going unnoticed -- so the guard converts silence into a recorded,
   * reviewable statement, and `whyStillEnabled` has to say something.
   *
   * `closureReason` is checked verbatim against the research registry, so the reason cannot drift
   * into a softer paraphrase on this side of the boundary.
   */
  terminalResearchAcknowledgement?: {
    readonly researchStrategyKey: string;
    readonly closureReason: string;
    /**
     * What was decided about this strategy in light of that verdict, and why.
     *
     * Was `whyStillEnabled` until 2026-09-02, which could only describe one of the two valid
     * dispositions. Renamed when `momentum-scalp-pattern-v2` was disabled: the record has to survive
     * the disable, or turning a strategy off would delete the reasoning that justified it.
     */
    readonly disposition: string;
  };
}

/** Both sides unless the registration narrows them. */
export function strategyExecutableSides(strategy: RegisteredStrategy): readonly TradeSide[] {
  return strategy.executableSides ?? ["LONG", "SHORT"];
}

/**
 * The single list of strategies the system knows about.
 *
 * Idea generation and historical backtesting both need the registration *and*
 * the class that implements it, and they previously disagreed: idea generation
 * ran both strategies while the backtest CLI was hard-wired to trend-breakout,
 * so momentum-scalp could produce ideas that nothing could ever measure. Order
 * is significant — idea generation reports results in this order.
 */
export const registeredStrategies: readonly RegisteredStrategy[] = [
  {
    registration: trendBreakoutStrategyRegistration,
    StrategyClass: TrendBreakoutStrategy,
    supportedTimeframes: ["15m", "30m", "60m", "1d"],
  },
  {
    registration: momentumScalpStrategyRegistration,
    StrategyClass: MomentumScalpStrategy,
    supportedTimeframes: ["1m"],
  },
  {
    registration: momentumScalpIndexStrategyRegistration,
    StrategyClass: MomentumScalpIndexStrategy,
    // 1m dropped 2026-08-20: closed paper trades on 1m were 89 trades / -Rs 13,858 net (30-41% win
    // rate on both NIFTY50 and BANKNIFTY, worse on BANKNIFTY), against 5m's roughly break-even -Rs
    // 674 over 76 trades. Matches the research findings that this architecture has no viable edge at
    // any bracket width or holding horizon on either index (NO_VIABLE_STOP_MULTIPLE, NO_VIABLE_HORIZON).
    supportedTimeframes: ["5m"],
    /*
     * LONG disabled 2026-09-02. The "roughly break-even" figure above justified keeping 5m enabled
     * and is now stale; measured over every closed paper trade on this strategy, the two sides have
     * diverged and 5m as a whole is far from break-even:
     *
     *   5m SHORT   93 trades   47.3% win   +Rs  1,384
     *   5m LONG    62 trades   35.5% win   -Rs 13,414
     *   5m total  155 trades               -Rs 12,030   (the comment above says -Rs 674 over 76)
     *
     * The long side is negative on almost every session in the record, and it accounts for the whole
     * of the loss. Short is left enabled: it was positive on every session but one until a -Rs 6,189
     * morning on 2026-09-02, when both indices rallied off the open and it shorted into the move --
     * one adverse-trend session against a persistently positive cell is not grounds to disable it,
     * and doing so on that basis would be the overfitting the research programme keeps warning about.
     *
     * No edge is claimed for short. This narrows a measured loser; it does not promote the remainder.
     */
    executableSides: ["SHORT"],
    terminalResearchAcknowledgement: {
      researchStrategyKey: "index-v3-research",
      closureReason: "horizon sweep returned NO_VIABLE_HORIZON; both width and holding period exhausted",
      disposition:
        "ENABLED (short only). The research verdict closes this architecture under the harness's "
        + "canonical geometry, where "
        + "both bracket width and holding horizon were swept. It is not a measurement of the live 5m "
        + "short cell, which is separately positive over 93 trades (+Rs 1,384, 47.3% win). The long "
        + "side, which the research verdict fits, was disabled on 2026-09-02 (-Rs 13,414 over 62). "
        + "Short is retained on its own live record with no edge claimed, and is the first thing to "
        + "drop if that record turns.",
    },
  },
  {
    registration: momentumScalpPatternStrategyRegistration,
    StrategyClass: MomentumScalpPatternStrategy,
    supportedTimeframes: ["1m", "3m", "5m"],
    /*
     * LONG disabled 2026-09-02, on the same evidence and the same day as momentum-scalp-index.
     * Measured over every closed 5m paper trade on this strategy:
     *
     *   5m SHORT   32 trades   50.0% win   +Rs    424
     *   5m LONG    36 trades   36.1% win   -Rs  8,531
     *
     * The split is close to identical to the index scalp's (LONG 35.5% / -Rs 13,414, SHORT 47.9% /
     * +Rs 2,899), which is suggestive rather than confirmatory: both strategies are built on the same
     * momentum architecture, so this is plausibly one flaw observed twice rather than two independent
     * findings. Either way the long cell is the loser on its own 36 trades and does not need the
     * cross-strategy argument to justify disabling it.
     *
     * Short is left enabled at +Rs 424 over 32 trades, which is barely distinguishable from zero. No
     * edge is claimed; it is retained because nothing measured argues against it, and it is a
     * candidate for review well before the index short is.
     */
    executableSides: ["SHORT"],
  },
  {
    registration: momentumScalpPatternStrategyV2Registration,
    StrategyClass: MomentumScalpPatternStrategyV2,
    supportedTimeframes: ["1m", "3m", "5m"],
    /*
     * Disabled entirely 2026-09-02 -- both sides, not a side restriction.
     *
     * The evidence is asymmetric rather than balanced. Against it: a TERMINAL research verdict
     * measured over 13.7k-18.6k trades per cell, monotonic degradation on both deep ETFs. For it: one
     * closed trade, +Rs 188. One trade cannot overturn that prior, and leaving it enabled is how a
     * single trade quietly becomes a positive result.
     *
     * Disabled operationally, preserved scientifically. It stays registered rather than deleted so
     * its version, lineage and this reasoning survive, and the research harness keeps evaluating its
     * frozen twin ungated on every bar -- so the population it would have traded remains measurable
     * and the decision stays falsifiable.
     *
     * Deliberately NOT marked TERMINAL on the research side. Terminal means the line of inquiry is
     * closed, and the generation-2 pattern question has not been answered -- it has barely been
     * asked. `pattern-v4-research-v2` stays RESEARCH / NOT_YET_ELIGIBLE.
     */
    executableSides: [],
    terminalResearchAcknowledgement: {
      researchStrategyKey: "pattern-v4-research",
      closureReason: "degrades the base strategy monotonically on both deep ETFs",
      disposition:
        "DISABLED (both sides) 2026-09-02. The evidence is asymmetric: a TERMINAL verdict measured "
        + "over 13.7k-18.6k trades per cell against one closed trade of +Rs 188, which is nowhere "
        + "near enough to overturn the prior. Registered but trading nothing, so its lineage and this "
        + "reasoning survive and the research twin keeps measuring the population ungated. Not marked "
        + "TERMINAL: the generation-2 question is unanswered, not closed.",
    },
  },
];

export function strategySupportsTimeframe(strategy: RegisteredStrategy, timeframe: string): boolean {
  return strategy.supportedTimeframes.includes(timeframe);
}

export function strategyKeys(): string[] {
  return registeredStrategies.map((strategy) => strategy.registration.strategyKey);
}

export function findRegisteredStrategy(strategyKey: string): RegisteredStrategy | null {
  return registeredStrategies.find((strategy) => strategy.registration.strategyKey === strategyKey) ?? null;
}

export function requireRegisteredStrategy(strategyKey: string): RegisteredStrategy {
  const strategy = findRegisteredStrategy(strategyKey);
  if (!strategy) {
    throw new Error(`Unknown strategy "${strategyKey}". Use: ${strategyKeys().join(", ")}.`);
  }
  return strategy;
}
