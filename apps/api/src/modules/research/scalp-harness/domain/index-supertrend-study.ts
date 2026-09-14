import {
  defaultMomentumScalpIndexStrategyConfiguration,
  type MomentumScalpIndexStrategyConfiguration,
} from "../../../strategy-engine/domain/momentum-scalp-index-strategy.js";
import type { ProposedTradeIdea, StrategyMarketContext, TradeSide } from "../../../strategy-engine/domain/strategy.js";

/**
 * A research-only evaluator that captures EMA/RSI index setups **whether or not Supertrend agrees**.
 *
 * ## The question this exists to make answerable
 *
 * The production index strategy writes Supertrend agreement into its trigger:
 * `supertrendTrend === "UP" && emaFast > emaSlow && rsi in band`. A bar where Supertrend disagrees
 * therefore produces no proposal at all, so the disagreeing population is never observed — and a
 * population you never observe cannot tell you whether the filter that removed it was doing any work.
 * The frozen plan asks for `supertrendHeadroomAtr` to be logged *continuously*, which is impossible
 * while agreement is a precondition for logging anything.
 *
 * Two different estimands are at stake, and only the second needs this class:
 *
 * - **A — historical setup edge.** "EMA/RSI candidate *plus* Supertrend agreement, versus matched
 *   controls." `index-v3-research` answers this correctly and is unaffected by anything here.
 * - **B — incremental value of Supertrend.** "Does agreement actually improve outcomes?" This requires
 *   the disagreeing arm, which only this evaluator produces.
 *
 * ## Why it is a separate class rather than an edit
 *
 * `MomentumScalpIndexStrategy` is wired into the production strategy registry. Removing the directional
 * condition from it would change live paper-trading behaviour, and the frozen source checksums exist to
 * make exactly that kind of edit impossible to do quietly. So the study is additive: production is
 * untouched, and this class carries its own version.
 *
 * The obvious risk of a parallel implementation is drift — this computing something subtly different
 * from the strategy it claims to extend. `index-supertrend-study.test.ts` pins that down by asserting
 * that on Supertrend-*aligned* bars this evaluator reproduces the production strategy's geometry
 * exactly. Divergence fails the build rather than quietly biasing a study.
 */

export const indexSupertrendStudyVersion = "index-supertrend-study-v1-research";

export interface SupertrendStudyCandidate {
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly expiresAt: Date;
  /** "UP" / "DOWN" as reported by the indicator at this bar. */
  readonly supertrendDirection: string;
  /** Whether the direction agreed with the candidate side — the variable under study, not a filter. */
  readonly supertrendAligned: boolean;
  /** Signed distance from close to the Supertrend band, in ATR units. Negative when price is beyond it. */
  readonly supertrendHeadroomAtr: number;
  readonly emaSpreadAtr: number;
  readonly rsiValue: number;
  readonly atrValue: number;
}

interface ResolvedStudyIndicators {
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly rsi: number;
  readonly supertrendValue: number;
  readonly supertrendTrend: string;
  readonly atr: number;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findIndicator(
  context: StrategyMarketContext,
  code: string,
  algorithmVersion: string,
  parameters: Record<string, unknown> | undefined,
): StrategyMarketContext["indicators"][number] | undefined {
  return context.indicators.find((item) => (
    item.code === code
    && item.algorithmVersion === algorithmVersion
    && (parameters === undefined
      || Object.entries(parameters).every(([key, value]) => item.parameters[key] === value))
  ));
}

function resolveIndicators(
  context: StrategyMarketContext,
  configuration: MomentumScalpIndexStrategyConfiguration,
): ResolvedStudyIndicators | null {
  const version = configuration.indicatorAlgorithmVersion;
  const emaFast = findIndicator(context, "EMA", version, configuration.indicatorParameters.EMA_FAST);
  const emaSlow = findIndicator(context, "EMA", version, configuration.indicatorParameters.EMA_SLOW);
  const rsi = findIndicator(context, "RSI", version, configuration.indicatorParameters.RSI);
  const supertrend = findIndicator(context, "SUPERTREND", version, configuration.indicatorParameters.SUPERTREND);
  const atr = findIndicator(context, "ATR", version, configuration.indicatorParameters.ATR);
  if (!emaFast || !emaSlow || !rsi || !supertrend || !atr) return null;

  const emaFastValue = numeric(emaFast.values.value);
  const emaSlowValue = numeric(emaSlow.values.value);
  const rsiValue = numeric(rsi.values.value);
  const supertrendValue = numeric(supertrend.values.value);
  const atrValue = numeric(atr.values.value);
  const supertrendTrend = typeof supertrend.values.trend === "string" ? supertrend.values.trend : null;
  if (emaFastValue === null || emaSlowValue === null || rsiValue === null
    || supertrendValue === null || supertrendTrend === null || atrValue === null || atrValue <= 0) {
    return null;
  }
  return {
    emaFast: emaFastValue, emaSlow: emaSlowValue, rsi: rsiValue,
    supertrendValue, supertrendTrend, atr: atrValue,
  };
}

function roundToTick(value: number, tickSize: number): number {
  return Number((Math.round(value / tickSize) * tickSize).toFixed(10));
}
function roundDownToTick(value: number, tickSize: number): number {
  return Number((Math.floor(value / tickSize) * tickSize).toFixed(10));
}
function roundUpToTick(value: number, tickSize: number): number {
  return Number((Math.ceil(value / tickSize) * tickSize).toFixed(10));
}

const timeframeMinutes: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "60m": 60 };

/**
 * Emits every EMA/RSI index candidate on this bar, aligned or not.
 *
 * The EMA cross and RSI band are retained deliberately: they are the setup definition — the hypothesis
 * about *when* a momentum candidate exists — and dropping them too would not produce an unfiltered
 * strategy but no strategy at all. The every-bar baseline already exists as the matched control grid.
 * Supertrend alone moves from precondition to recorded variable.
 */
export function evaluateSupertrendStudy(
  context: StrategyMarketContext,
  configuration: MomentumScalpIndexStrategyConfiguration = defaultMomentumScalpIndexStrategyConfiguration,
): SupertrendStudyCandidate[] {
  const indicators = resolveIndicators(context, configuration);
  if (!indicators) return [];

  const tickSize = context.candle.tickSize;
  const minutes = timeframeMinutes[context.candle.timeframe];
  if (!Number.isFinite(tickSize) || tickSize <= 0 || context.candle.close <= 0 || minutes === undefined) return [];

  const sides: TradeSide[] = [];
  if (indicators.emaFast > indicators.emaSlow
    && indicators.rsi >= configuration.rsiLongMin && indicators.rsi <= configuration.rsiLongMax) {
    sides.push("LONG");
  }
  if (indicators.emaFast < indicators.emaSlow
    && indicators.rsi >= configuration.rsiShortMin && indicators.rsi <= configuration.rsiShortMax) {
    sides.push("SHORT");
  }

  const candidates: SupertrendStudyCandidate[] = [];
  for (const side of sides) {
    const entryPrice = roundToTick(context.candle.close, tickSize);
    const stopDistance = Math.max(tickSize, indicators.atr * configuration.atrStopMultiple);
    const stopLoss = side === "LONG"
      ? roundDownToTick(entryPrice - stopDistance, tickSize)
      : roundUpToTick(entryPrice + stopDistance, tickSize);
    const risk = Math.abs(entryPrice - stopLoss);
    if (risk <= 0) continue;
    const targetPrice = side === "LONG"
      ? roundToTick(entryPrice + risk * configuration.rewardRiskMultiple, tickSize)
      : roundToTick(entryPrice - risk * configuration.rewardRiskMultiple, tickSize);
    if (stopLoss <= 0 || targetPrice <= 0) continue;
    if (side === "LONG" && (stopLoss >= entryPrice || targetPrice <= entryPrice)) continue;
    if (side === "SHORT" && (stopLoss <= entryPrice || targetPrice >= entryPrice)) continue;

    // Signed on purpose: a disagreeing bar has price on the far side of the band, and the magnitude of
    // that disagreement is exactly what a response surface over headroom needs.
    const headroom = side === "LONG"
      ? (context.candle.close - indicators.supertrendValue) / indicators.atr
      : (indicators.supertrendValue - context.candle.close) / indicators.atr;

    candidates.push({
      side,
      entryPrice,
      stopLoss,
      targetPrice,
      expiresAt: new Date(context.candle.closeTime.getTime() + minutes * 60_000 * configuration.expiryCandles),
      supertrendDirection: indicators.supertrendTrend,
      supertrendAligned: indicators.supertrendTrend === (side === "LONG" ? "UP" : "DOWN"),
      supertrendHeadroomAtr: Number(headroom.toFixed(6)),
      emaSpreadAtr: Number((Math.abs(indicators.emaFast - indicators.emaSlow) / indicators.atr).toFixed(6)),
      rsiValue: indicators.rsi,
      atrValue: indicators.atr,
    });
  }
  return candidates;
}

/** Narrows a study candidate to the arm the production strategy would also have produced. */
export function alignedCandidates(candidates: readonly SupertrendStudyCandidate[]): SupertrendStudyCandidate[] {
  return candidates.filter((candidate) => candidate.supertrendAligned);
}

/** Shapes a production proposal for geometry comparison in the drift test. */
export function geometryOf(proposal: ProposedTradeIdea): { side: TradeSide; entryPrice: number; stopLoss: number; targetPrice: number } {
  return {
    side: proposal.side,
    entryPrice: proposal.entryPrice,
    stopLoss: proposal.stopLoss,
    targetPrice: proposal.targetPrice,
  };
}
