import type { EnsureStrategyVersionInput, ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";
import { MomentumScalpStrategy, momentumScalpStrategyRegistration } from "./momentum-scalp-strategy.js";
import { TrendBreakoutStrategy, trendBreakoutStrategyRegistration } from "./trend-breakout-strategy.js";

/** What every strategy implementation must offer to a caller that replays candles. */
export interface StrategyEvaluator {
  evaluate(context: StrategyMarketContext, strategyConfiguration: Record<string, unknown>): ProposedTradeIdea[];
}

export interface RegisteredStrategy {
  registration: EnsureStrategyVersionInput;
  StrategyClass: new () => StrategyEvaluator;
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
  { registration: trendBreakoutStrategyRegistration, StrategyClass: TrendBreakoutStrategy },
  { registration: momentumScalpStrategyRegistration, StrategyClass: MomentumScalpStrategy },
];

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
