import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../strategy-engine/domain/strategy-registry.js";
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
