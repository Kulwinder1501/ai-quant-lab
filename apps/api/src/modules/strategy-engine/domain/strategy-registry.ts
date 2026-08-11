import type { EnsureStrategyVersionInput, ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";
import { MomentumScalpStrategy, momentumScalpStrategyRegistration } from "./momentum-scalp-strategy.js";
import { MomentumScalpIndexStrategy, momentumScalpIndexStrategyRegistration } from "./momentum-scalp-index-strategy.js";
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
    supportedTimeframes: ["1m", "5m"],
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
