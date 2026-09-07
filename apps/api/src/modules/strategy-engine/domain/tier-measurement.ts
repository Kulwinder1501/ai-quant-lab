import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import { breakEvenHitRate, resolveBracket } from "./bracket-outcome.js";
import type { ProposedTradeIdea, StrategyMarketContext, TradeSide } from "./strategy.js";

/**
 * Replays a registered strategy over stored bars and reports whether its signals have edge.
 *
 * This exists because twelve days of live operation produced two signals and three closed trades --
 * not a bad result, an absent one. Reading a P&L off that is impossible, and enabling three more
 * timeframes on top would multiply signal count without establishing that any single signal is
 * worth taking. Scalp, intraday and swing are the same question asked at three bar sizes, so they
 * get one measurement rather than three opinions.
 *
 * ## What is compared, and why the baseline is the important column
 *
 * Every signal is resolved through the strategy's **own** bracket using the paper-trading exit
 * policy, so a gap fills at the open and a bar spanning both levels resolves as a stop. Then two
 * reference points:
 *
 * - **Break-even** `1 / (1 + rewardRisk)`: the hit rate at which the geometry stops losing money
 *   before costs. Necessary, and nowhere near sufficient.
 * - **Unconditional**: the same side with the same geometry taken on *every* bar, ignoring the
 *   strategy. This is the column that matters. A strategy beating break-even while matching its
 *   unconditional baseline has discovered the bracket, not an edge -- and that is invisible in a
 *   live P&L for months. It is exactly how the autonomous agent's SHORT gate was found to select
 *   *worse* than taking every bar.
 *
 * ## Costs are reported as a budget, not modelled
 *
 * These brackets are in the underlying's points while the positions are option premiums, so a
 * rupee cost model here would be a second invented number. Instead the gross expectancy in R *is*
 * the cost budget: it is what the round trip may cost, per trade, before the edge is zero. A
 * strategy at +0.05R has five hundredths of a risk unit to pay a spread, brokerage and slippage
 * out of, which is the honest way to look at a 1.5R scalp.
 */

export interface TierStrategyLike {
  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[];
}

export interface TierMeasurementInput {
  /** Completed contexts in chronological order, oldest first. */
  contexts: readonly StrategyMarketContext[];
  strategy: TierStrategyLike;
  configuration: Record<string, unknown>;
  /** Bars a bracket may take to resolve before it is recorded unresolved. */
  horizonBars: number;
  /** The strategy's own geometry, used to build the unconditional baseline on equal terms. */
  atrStopMultiple: number;
  rewardRiskMultiple: number;
  /** Indicator code and algorithm version the baseline reads its ATR from. */
  atrCode?: string;
  atrAlgorithmVersion?: string;
}

export interface SideOutcome {
  signals: number;
  resolved: number;
  targets: number;
  unresolved: number;
  hitRate: number | null;
  expectancyR: number | null;
  /** Median bars to resolution, which says whether a "scalp" is actually holding for hours. */
  medianBarsToResolution: number | null;
}

export interface TierMeasurement {
  barsScored: number;
  sessions: number;
  breakEvenHitRate: number;
  /** Signals per session, which is what a claimed "8-20 a day" can be checked against. */
  signalsPerSession: number | null;
  gated: Record<TradeSide, SideOutcome>;
  unconditional: Record<TradeSide, SideOutcome>;
  /** Bars skipped because no production ATR snapshot existed to build a baseline bracket. */
  skippedNoAtr: number;
  verdict: string;
}

interface Accumulator {
  signals: number;
  resolved: number;
  targets: number;
  unresolved: number;
  totalR: number;
  bars: number[];
}

function emptyAccumulator(): Accumulator {
  return { signals: 0, resolved: 0, targets: 0, unresolved: 0, totalR: 0, bars: [] };
}

function record(
  accumulator: Accumulator,
  outcome: "TARGET" | "STOP" | "UNRESOLVED",
  rMultiple: number | null,
  barsToResolution: number | null,
): void {
  accumulator.signals += 1;
  if (outcome === "UNRESOLVED") {
    accumulator.unresolved += 1;
    return;
  }
  accumulator.resolved += 1;
  if (outcome === "TARGET") accumulator.targets += 1;
  if (rMultiple !== null) accumulator.totalR += rMultiple;
  if (barsToResolution !== null) accumulator.bars.push(barsToResolution);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarise(accumulator: Accumulator): SideOutcome {
  return {
    signals: accumulator.signals,
    resolved: accumulator.resolved,
    targets: accumulator.targets,
    unresolved: accumulator.unresolved,
    // Rates over resolved brackets only. Folding unresolved ones into either bucket inflates the
    // rate, so they are reported beside it instead.
    hitRate: accumulator.resolved === 0
      ? null
      : Number((accumulator.targets / accumulator.resolved).toFixed(4)),
    expectancyR: accumulator.resolved === 0
      ? null
      : Number((accumulator.totalR / accumulator.resolved).toFixed(4)),
    medianBarsToResolution: median(accumulator.bars),
  };
}

function toPriceCandle(context: StrategyMarketContext): CompletedPriceCandle {
  return {
    id: context.candle.id,
    openTime: context.candle.openTime,
    closeTime: context.candle.closeTime,
    open: context.candle.open,
    high: context.candle.high,
    low: context.candle.low,
    close: context.candle.close,
  };
}

function findAtr(
  context: StrategyMarketContext,
  code: string,
  algorithmVersion: string,
): number | null {
  for (const indicator of context.indicators) {
    if (indicator.code !== code || indicator.algorithmVersion !== algorithmVersion) continue;
    const value = indicator.values["value"];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Judges the two columns that decide whether a tier is worth deploying.
 *
 * Deliberately blunt, and deliberately not a score: a tier is worth trading only if it clears
 * break-even *and* beats the population it was drawn from. Either alone is a known trap.
 */
function verdictFor(
  gated: Record<TradeSide, SideOutcome>,
  unconditional: Record<TradeSide, SideOutcome>,
  breakEven: number,
): string {
  const notes: string[] = [];
  for (const side of ["LONG", "SHORT"] as const) {
    const g = gated[side];
    const u = unconditional[side];
    if (g.resolved === 0) {
      notes.push(`${side}: no resolved signals, nothing measured.`);
      continue;
    }
    if (g.hitRate === null || u.hitRate === null) continue;
    const clearsBreakEven = g.hitRate > breakEven;
    const beatsBaseline = g.hitRate > u.hitRate;
    const delta = Number((g.hitRate - u.hitRate).toFixed(4));
    if (clearsBreakEven && beatsBaseline) {
      notes.push(`${side}: clears break-even and beats its baseline by ${delta}. Worth deploying.`);
    } else if (!clearsBreakEven) {
      notes.push(`${side}: below break-even at ${g.hitRate}. Loses before costs.`);
    } else {
      notes.push(
        `${side}: clears break-even but is ${delta} against its own baseline -- the geometry is `
        + "carrying it, not the selection.",
      );
    }
  }
  return notes.join(" ");
}

export function measureTier(input: TierMeasurementInput): TierMeasurement {
  const atrCode = input.atrCode ?? "ATR";
  const atrAlgorithmVersion = input.atrAlgorithmVersion ?? "ta-v1";
  const contexts = input.contexts;
  const bars = contexts.map(toPriceCandle);
  const gated: Record<TradeSide, Accumulator> = { LONG: emptyAccumulator(), SHORT: emptyAccumulator() };
  const unconditional: Record<TradeSide, Accumulator> = { LONG: emptyAccumulator(), SHORT: emptyAccumulator() };

  const sessions = new Set<string>();
  let barsScored = 0;
  let skippedNoAtr = 0;

  // The last `horizonBars` bars are excluded from scoring: a signal there has no forward window,
  // and counting it as unresolved would understate every rate by a fixed tail.
  for (let index = 0; index < contexts.length - input.horizonBars; index += 1) {
    const context = contexts[index]!;
    barsScored += 1;
    sessions.add(context.candle.closeTime.toISOString().slice(0, 10));
    const forward = bars.slice(index + 1, index + 1 + input.horizonBars);

    // --- The strategy's own signals -----------------------------------------------------
    for (const idea of input.strategy.evaluate(context, input.configuration)) {
      const resolution = resolveBracket({
        side: idea.side,
        entryPrice: idea.entryPrice,
        stopLoss: idea.stopLoss,
        targetPrice: idea.targetPrice,
      }, forward);
      record(gated[idea.side], resolution.outcome, resolution.rMultiple, resolution.barsToResolution);
    }

    // --- The baseline, on the strategy's own geometry ------------------------------------
    const atrValue = findAtr(context, atrCode, atrAlgorithmVersion);
    if (atrValue === null) {
      skippedNoAtr += 1;
      continue;
    }
    const entryPrice = context.candle.close;
    const stopDistance = atrValue * input.atrStopMultiple;
    const targetDistance = stopDistance * input.rewardRiskMultiple;
    for (const side of ["LONG", "SHORT"] as const) {
      const resolution = resolveBracket({
        side,
        entryPrice,
        stopLoss: side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance,
        targetPrice: side === "LONG" ? entryPrice + targetDistance : entryPrice - targetDistance,
      }, forward);
      record(unconditional[side], resolution.outcome, resolution.rMultiple, resolution.barsToResolution);
    }
  }

  const gatedSummary = { LONG: summarise(gated.LONG), SHORT: summarise(gated.SHORT) };
  const unconditionalSummary = { LONG: summarise(unconditional.LONG), SHORT: summarise(unconditional.SHORT) };
  const breakEven = Number(breakEvenHitRate(input.rewardRiskMultiple).toFixed(4));
  const totalSignals = gatedSummary.LONG.signals + gatedSummary.SHORT.signals;

  return {
    barsScored,
    sessions: sessions.size,
    breakEvenHitRate: breakEven,
    signalsPerSession: sessions.size === 0 ? null : Number((totalSignals / sessions.size).toFixed(2)),
    gated: gatedSummary,
    unconditional: unconditionalSummary,
    skippedNoAtr,
    verdict: verdictFor(gatedSummary, unconditionalSummary, breakEven),
  };
}
