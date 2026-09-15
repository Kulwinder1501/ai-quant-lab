import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";

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
