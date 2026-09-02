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
  },
  {
    registration: momentumScalpPatternStrategyRegistration,
    StrategyClass: MomentumScalpPatternStrategy,
    supportedTimeframes: ["1m", "3m", "5m"],
  },
  {
    registration: momentumScalpPatternStrategyV2Registration,
    StrategyClass: MomentumScalpPatternStrategyV2,
    supportedTimeframes: ["1m", "3m", "5m"],
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
