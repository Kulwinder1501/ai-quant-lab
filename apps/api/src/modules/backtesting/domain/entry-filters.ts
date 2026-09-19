import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
import { filterProposalsByLiquiditySweepBias } from "../../strategy-engine/domain/smc-liquidity-bias.js";
import { applySmcConfluenceToProposal } from "../../strategy-engine/domain/smc-confluence.js";

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

/** Minutes since IST midnight, e.g. 09:15 IST -> 555. */
export function istMinuteOfDay(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** A half-open [startMinute, endMinute) window of IST minute-of-day, entry blocked while inside it. */
export interface BlockedIstWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * Admits a bar's proposal only when its own open time falls outside every blocked IST window.
 *
 * Registered as part of `docs/2026-09-16-scalp1m-time-of-day-falsification-v1.md`, configs A/B/C.
 * Gates on the CANDLE's time, not the proposal's, so what is blocked is when the strategy is
 * allowed to open a new position -- an already-open trade already reaching its bar-by-bar barrier
 * check elsewhere in the engine is untouched by this filter.
 */
export class TimeWindowFilteredStrategy implements StrategyEvaluator {
  constructor(
    private readonly inner: StrategyEvaluator,
    private readonly blockedWindows: readonly BlockedIstWindow[],
  ) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    if (proposals.length === 0) return [];
    const minuteOfDay = istMinuteOfDay(context.candle.openTime);
    const blocked = this.blockedWindows.some(
      (window) => minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute,
    );
    return blocked ? [] : proposals;
  }
}

/**
 * Admits a bar only when its own volume is at least `multiple` times the mean of the prior
 * `lookback` bars' volume, keyed per instrument+timeframe series.
 *
 * The baseline is built from bars STRICTLY BEFORE the signal bar -- the signal bar's own volume is
 * never in its own denominator, which would inflate the ratio on exactly the bars a real breakout
 * would want to admit. Fail-closed, matching `EmaStrengthFilteredStrategy`: fewer than `lookback`
 * prior bars is an insufficient baseline, not a free pass, so the population under this filter's
 * name is never larger than what it could actually evaluate.
 */
export class RelativeVolumeFilteredStrategy implements StrategyEvaluator {
  static readonly DEFAULT_MULTIPLE = 1.5;
  static readonly DEFAULT_LOOKBACK = 20;

  private readonly recentVolumeBySeries = new Map<string, number[]>();

  constructor(
    private readonly inner: StrategyEvaluator,
    private readonly multiple: number = RelativeVolumeFilteredStrategy.DEFAULT_MULTIPLE,
    private readonly lookback: number = RelativeVolumeFilteredStrategy.DEFAULT_LOOKBACK,
  ) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    const seriesKey = `${context.candle.instrumentId}:${context.candle.timeframe}`;
    const history = this.recentVolumeBySeries.get(seriesKey) ?? [];

    let result: ProposedTradeIdea[] = [];
    if (proposals.length > 0 && history.length >= this.lookback) {
      const baseline = history.reduce((sum, value) => sum + value, 0) / history.length;
      if (baseline > 0 && context.candle.volume >= this.multiple * baseline) result = proposals;
    }

    history.push(context.candle.volume);
    if (history.length > this.lookback) history.shift();
    this.recentVolumeBySeries.set(seriesKey, history);
    return result;
  }
}

/**
 * Replays the live decision pipeline's SMC confidence gate: optionally applies the real
 * `applySmcConfluenceToProposal` (the same function `generate-trade-ideas.ts` calls), then drops
 * anything below the options-entry floor (`options-entry-validator.ts`'s literal `0.6`).
 *
 * Registered for `docs/2026-09-17-scalp1m-smc-gate-falsification-v1.md`. `applySmc: true` is the
 * control -- the closest a backtest can get to today's live behaviour, since the generic backtest
 * engine never calls `applySmcConfluenceToProposal` at all (only `generate-trade-ideas.ts` does).
 * `applySmc: false` is the arm under test: does the strategy do any better if this confidence
 * adjustment is skipped, still gated at the same floor.
 */
export class SmcConfidenceGatedStrategy implements StrategyEvaluator {
  static readonly OPTIONS_ENTRY_MINIMUM_CONFIDENCE = 0.6;

  constructor(
    private readonly inner: StrategyEvaluator,
    private readonly applySmc: boolean,
    private readonly minimumConfidence: number = SmcConfidenceGatedStrategy.OPTIONS_ENTRY_MINIMUM_CONFIDENCE,
  ) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    if (proposals.length === 0) return [];
    const adjusted = this.applySmc
      ? proposals.map((proposal) => applySmcConfluenceToProposal(context, proposal))
      : proposals;
    return adjusted.filter((proposal) => proposal.confidence >= this.minimumConfidence);
  }
}

/**
 * Drops a proposal when the bar's own candlestick pattern(s) agree with its direction.
 *
 * Registered for `docs/2026-09-17-scalp1m-pattern-alignment-falsification-v1.md`. Live-idea data
 * (277 `momentum-scalp` ideas, deduplicated per idea across every pattern detected on its source
 * bar) found the opposite of naive intuition: a bar whose only pattern(s) *agree* with the
 * proposal's side hits target 33.8% of the time (n=66), against 49.1% when a pattern *contradicts*
 * it (n=57) and 42.0% with no pattern at all (n=151) -- a confirming candlestick shape correlates
 * with a *worse* outcome here, not a better one.
 *
 * A bar can carry several detected patterns at once (up to 4, in this data) with different
 * directions; `hasAligned`/`hasContradicting` are independent booleans over the whole set, not a
 * single verdict, so a bar with both an agreeing and a disagreeing pattern is neither silently
 * dropped nor silently kept under one label.
 */
export class PatternAlignmentFilteredStrategy implements StrategyEvaluator {
  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposals = this.inner.evaluate(context, configuration);
    if (proposals.length === 0) return [];
    return proposals.filter((proposal) => {
      const hasAligned = context.patterns.some((pattern) => (
        (pattern.direction === "BULLISH" && proposal.side === "LONG")
        || (pattern.direction === "BEARISH" && proposal.side === "SHORT")
      ));
      return !hasAligned;
    });
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
