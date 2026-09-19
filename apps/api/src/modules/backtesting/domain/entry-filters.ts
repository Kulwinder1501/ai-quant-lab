import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
import { filterProposalsByLiquiditySweepBias } from "../../strategy-engine/domain/smc-liquidity-bias.js";

/**
 * Backtest-only entry filters: decorators that drop a strategy's proposals without touching it.
 *
 * They live here rather than inside `run-backtest.ts` so they can be tested. Declared in the CLI
 * they were unreachable from a test, which for `FreshSetupFilteredStrategy` mattered most of all --
 * it carries state, and the three things worth asserting about it (suppress a repeat, pass a flip,
 * reset after a quiet bar) were exactly the three nothing covered.
 *
 * A filter is a MEASUREMENT instrument, not a candidate for the live path. Anything that survives
 * here has to be re-derived inside the strategy under a new research version before it can trade;
 * see `docs/exit-geometry-falsification-program-v1.md` for the equivalent discipline on exits.
 */

/** The value of a single-output indicator on a context, or null when it is absent. */
export function indicatorValue(
  context: StrategyMarketContext,
  code: string,
  period: number,
): number | null {
  const indicator = context.indicators.find((candidate) => (
    candidate.code === code
    && candidate.parameters.period === period
    && typeof candidate.values.value === "number"
  ));
  return indicator && typeof indicator.values.value === "number" ? indicator.values.value : null;
}

/**
 * Admits a bar only when the fast/slow EMA separation is at least 15% of ATR.
 *
 * Refuses when any input is missing, which is the fail-closed direction: a filter that silently
 * passes every bar because its indicator is absent reports the unfiltered population under the
 * filter's name. (EMA 3, EMA 8 and ATR 14 are all present on 1m -- ~806k snapshots each as of
 * 2026-09-09 -- so this refusal is a guard, not the normal path.)
 *
 * Read the result against `chop-filter-candidates-refuted`: the closest measured analogue is the
 * Kaufman efficiency ratio, where losses scored 0.38 against wins at 0.28 -- the sign backwards.
 * This asks a similar question of the same tape, so a positive result here needs to survive that
 * prior rather than be read as new evidence.
 */
export class EmaStrengthFilteredStrategy implements StrategyEvaluator {
  static readonly MINIMUM_SEPARATION_ATR_FRACTION = 0.15;

  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    if (proposals.length === 0) return [];

    const fast = indicatorValue(context, "EMA", 3);
    const slow = indicatorValue(context, "EMA", 8);
    const atr = indicatorValue(context, "ATR", 14);
    if (fast === null || slow === null || atr === null || atr <= 0) return [];

    const separation = Math.abs(fast - slow) / atr;
    return separation < EmaStrengthFilteredStrategy.MINIMUM_SEPARATION_ATR_FRACTION ? [] : proposals;
  }
}

/**
 * Admits the first proposal of a run of same-side proposals, and suppresses the repeats.
 *
 * A continuously satisfied setup re-proposes on every bar, so a single condition can enter many
 * times; this keeps one entry per direction until the direction changes. A quiet bar clears the
 * memory, so the setup re-arms rather than staying suppressed for the rest of the session.
 *
 * Distinct from the direction-flip cooldown already measured and refuted: that blocked REVERSALS
 * within 30 minutes, and found a 25% win rate on both sides. This blocks REPEATS and lets flips
 * through, which is the opposite population.
 *
 * Keyed per instrument and timeframe. One backtest run covers a single series, so a scalar would
 * work today -- and would silently interleave two series the first time one did not, which is the
 * kind of latency this class was written to avoid rather than inherit.
 */
export class FreshSetupFilteredStrategy implements StrategyEvaluator {
  private readonly previousSideBySeries = new Map<string, "LONG" | "SHORT">();

  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    const seriesKey = `${context.candle.instrumentId}:${context.candle.timeframe}`;
    const proposal = proposals[0];

    if (!proposal) {
      this.previousSideBySeries.delete(seriesKey);
      return [];
    }
    if (this.previousSideBySeries.get(seriesKey) === proposal.side) return [];
    this.previousSideBySeries.set(seriesKey, proposal.side);
    return proposals;
  }
}

/**
 * Adjusts the proposal's stop-loss tightly around the entry candle if a confluent pattern is detected.
 *
 * If a momentum setup fires LONG and there is a coincident BULLISH candlestick pattern,
 * the stop-loss is moved to exactly 1 tick below the candle's low. 
 * If SHORT and BEARISH, the stop is moved to 1 tick above the candle's high.
 * 
 * This is designed to test if pattern-confluence can massively increase R-multiple by 
 * validating much tighter risk parameters than standard ATR stops.
 */
export class PatternConfluenceFilteredStrategy implements StrategyEvaluator {
  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    if (proposals.length === 0) return [];

    const modifiedProposals: ProposedTradeIdea[] = [];

    for (const proposal of proposals) {
      // Find coincident patterns matching the proposal direction
      const targetDirection = proposal.side === "LONG" ? "BULLISH" : "BEARISH";
      const confluentPattern = context.patterns.find(p => p.direction === targetDirection);
      const opposingPattern = context.patterns.find(p => p.direction === (proposal.side === "LONG" ? "BEARISH" : "BULLISH"));

      // 1. Trap Avoidance: If a strong opposing pattern is present, we skip the trade.
      if (opposingPattern) {
        continue;
      }

      // 2. Confluence Boost: If a confluent pattern is present, tighten the stop.
      if (confluentPattern) {
        const tick = context.candle.tickSize > 0 ? context.candle.tickSize : 0.05;
        const newStop = proposal.side === "LONG" 
          ? context.candle.low - tick 
          : context.candle.high + tick;
        
        // Ensure the new stop is actually tighter than the original ATR stop
        const isTighter = proposal.side === "LONG" 
          ? newStop > proposal.stopLoss 
          : newStop < proposal.stopLoss;

        if (isTighter) {
          const risk = Math.abs(proposal.entryPrice - newStop);
          const reward = Math.abs(proposal.targetPrice - proposal.entryPrice);
          const newRR = risk > 0 ? reward / risk : 0;
          
          modifiedProposals.push({
            ...proposal,
            stopLoss: newStop,
            riskReward: newRR,
            confidence: Math.min(1.0, proposal.confidence + 0.10), // Boost confidence
            reasoning: [
              ...proposal.reasoning, 
              `Pattern confluence (${confluentPattern.code}): Boosted conf +10% and tightened stop to ${newStop}`
            ]
          });
          continue;
        }
      }

      // If no pattern modifications apply, pass the original proposal through
      modifiedProposals.push(proposal);
    }

    return modifiedProposals;
  }
}

/**
 * Blocks proposals whose direction opposes the most recent HTF liquidity sweep or CHOCH.
 *
 * Reads LIQUIDITY_SWEEP and CHOCH signals from the nearest completed higher-timeframe context
 * (e.g. 15m or 30m) and treats a BEARISH sweep as a bias to only allow SHORT entries, and a
 * BULLISH sweep as a bias to only allow LONG entries.
 *
 * If no sweep or CHOCH is present on the HTF, the filter is a no-op and all proposals pass.
 *
 * The HTF timeframe to check is passed at construction time. It must match a key in
 * `context.higherTimeframeContexts` — the same map the HTF confluence gate already uses.
 */
export class LiquiditySweepBiasFilteredStrategy implements StrategyEvaluator {
  constructor(
    private readonly inner: StrategyEvaluator,
    private readonly htfTimeframe: string,
  ) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    return filterProposalsByLiquiditySweepBias(context, proposals, this.htfTimeframe, {
      enforceSameSession: false,
    });
  }
}
