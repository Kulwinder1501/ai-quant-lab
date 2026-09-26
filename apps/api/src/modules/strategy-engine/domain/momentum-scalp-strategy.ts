import type { VolatilityRegime } from "./regime.js";
import { biasAgreesWith, htfBiasFrom, type HtfBias } from "./htf-bias.js";
import { isStrictlyHigherTimeframe } from "./timeframe-order.js";
import {
  type ProposedTradeIdea,
  type StrategyMarketContext,
  type TradeIdeaEvidence,
  type TradeSide,
} from "./strategy.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundDownToTick(value: number, tickSize: number): number {
  return Math.floor(value / tickSize) * tickSize;
}

function roundUpToTick(value: number, tickSize: number): number {
  return Math.ceil(value / tickSize) * tickSize;
}

function roundNearestToTick(value: number, tickSize: number): number {
  return Math.round(value / tickSize) * tickSize;
}

/** Milliseconds in one bar, or null when the timeframe is not one this rule understands. */
function timeframeMilliseconds(timeframe: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(timeframe);
  if (!match) return null;
  const unitMilliseconds = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * unitMilliseconds;
}

type IndicatorSnapshot = StrategyMarketContext["indicators"][number];

/**
 * Version 2.
 *
 * v1 could never produce an idea: it registered `VWAP: {}` while its own parser
 * rejected an empty parameter set, so `evaluate` threw on every call. Fixing that
 * changes the immutable configuration, and a strategy-version configuration is
 * immutable by contract, so the rule set is registered under a new version rather
 * than mutating v1 in place.
 */
/**
 * v3: Switches to EMA(3/8) — the market-standard 1m scalp pair — which creates
 * real crossovers multiple times per session (EMA 9/20 on a 1m bar are nearly
 * identical and rarely separate). Bands and exit geometry are also recalibrated:
 * RSI 55–75 / 25–45 (drops the exhaustion tail at 80/20), ATR stop 1.0× (was
 * 0.5× — stopped out on noise), and RRR 1.5 (provides edge over brokerage costs).
 */
/**
 * v4 widened the stop to 1.5× ATR and pushed the target to 2.0R. It is withdrawn here, and
 * v5 restores v3's geometry exactly. Rolling *forward* to v5 rather than reactivating the
 * stored v3 row is deliberate on two counts: a version configuration is immutable by contract
 * (see PostgresStrategyVersionRepository), and the boot seed treats the code-declared version
 * as authoritative — flipping `is_active` by hand while the code declared something else is
 * what crash-looped the API for eighteen hours on 2026-09-06. A fresh number also keeps trade
 * attribution unambiguous: rows under v5 are post-incident by construction.
 *
 * Why v4 is withdrawn, measured 2026-09-08 on its first and only live session:
 *
 * 11 trades, 0 wins, -6,291 net against 879 in fees -- a directional loss, not a friction one.
 * The widened stop is the amplifier rather than the cause: every entry was stopped, so the
 * 1.5× multiple simply made each of eleven wrong entries lose about half again as much as
 * v3's 1.0× would have. Realised stop distance moved from ~3.0% of premium under v3 to 3.93%.
 *
 * The promotion evidence never cleared this project's own bar. Seven monthly backtest windows
 * summed to +456.7 index points against v3's -2,625.3, but three of the seven were negative,
 * `metrics` recorded no trade count or win rate, and no session-clustered standard error was
 * attached to a difference read off summed net P&L -- the same error already booked against the
 * ICT comparison, where +-17k turned out to be t=-0.24. The windows were also run on 1m index
 * points while the live book trades options and pays real brokerage.
 *
 * Restoring 1.5R additionally restores stall eligibility. The MOMENTUM_STALL gate in
 * evaluate-open-paper-trades.ts admits a trade only when reward/risk <= 1.6, so v4's 2.0R
 * silently exempted the whole strategy from the time stop: 17 of 17 v3 trades were eligible
 * and 0 of 11 v4 trades were. That coupling is incidental rather than designed, and it is
 * addressed separately -- this rollback only stops feeding it.
 *
 * Rolling back reduces the size of a loss; it does not create edge. v3 lost money too
 * (-1,723 on 2026-09-04). Entry selection is untouched here.
 */
/**
 * v6 adds a higher-timeframe confluence gate, configurable and off by default at nothing -- see
 * `htfConfluenceMode`. Production had never populated any higher-timeframe context at all until
 * `GenerateTradeIdeas` began attaching it, so every confluence term in the codebase scored 0 on
 * live signals; this is the first rule that reads one.
 *
 * Measured before wiring, over the 28 closed 1m option trades to 2026-09-08: requiring agreement
 * blocks 12 of 28 at 15m and 2 of 28 at 5m. 5m is nearly inert because the 1m trigger already
 * requires price on the correct side of VWAP with EMA(3/8) aligned, which largely implies the 5m
 * relationship. 15m is the timeframe that binds, which is why it is the default.
 *
 * It is an exposure control, not an edge. At 15m the win rate is 25% among trades that agree and
 * 25% among those that conflict, so the gate removes good and bad in proportion. Any P&L
 * improvement it shows on a negative-expectancy book means "traded less" until the survivors beat
 * the blocked on win rate. That test has not passed, and this gate does not claim it.
 */
export const momentumScalpStrategyVersion = 6;

export const defaultMomentumScalpStrategyConfiguration: MomentumScalpStrategyConfiguration = {
  indicatorAlgorithmVersion: "ta-v1",
  indicatorParameters: {
    EMA_FAST: { period: 3 },
    EMA_SLOW: { period: 8 },
    RSI: { period: 14, smoothing: "WILDER" },
    // VWAP takes no period, but it does take a reset rule, and that rule is part
    // of what a stored VWAP value meant. Declaring it both satisfies the parser
    // and matches the contract the feature pipeline already uses.
    VWAP: { reset: "NSE_SESSION" },
    ATR: { period: 14, smoothing: "WILDER" },
  },
  candlestickAlgorithmVersion: "candlestick-v1",
  priceActionAlgorithmVersion: "price-action-v2",
  rsiLongMin: 55,
  rsiLongMax: 75,
  rsiShortMin: 25,
  rsiShortMax: 45,
  atrStopMultiple: 1.0,
  rewardRiskMultiple: 1.5,
  minimumConfidence: 0.5,
  expiryCandles: 5,
  requireRegime: false,
  minimumVwapDisplacementAtr: 0.10,
  idealVwapDisplacementAtr: 0.60,
  maximumVwapDisplacementAtr: 2.5,
  htfConfluenceMode: "REQUIRE_AGREEMENT",
  htfConfluenceTimeframe: "15m",
  htfConfluenceEmaPeriod: 20,
  htfConfluenceOnMissing: "ALLOW",
};

export const momentumScalpStrategyRegistration = {
  strategyKey: "momentum-scalp",
  name: "Momentum Scalp",
  description: "Fast EMA separation confirmed by VWAP displacement and a bounded RSI momentum band.",
  version: momentumScalpStrategyVersion,
  configuration: { ...defaultMomentumScalpStrategyConfiguration } as Record<string, unknown>,
};

export interface MomentumScalpStrategyConfiguration {
  indicatorAlgorithmVersion: string;
  indicatorParameters: Record<string, Record<string, number | string | boolean>>;
  candlestickAlgorithmVersion: string;
  priceActionAlgorithmVersion: string;
  rsiLongMin: number;
  rsiLongMax: number;
  rsiShortMin: number;
  rsiShortMax: number;
  atrStopMultiple: number;
  rewardRiskMultiple: number;
  minimumConfidence: number;
  expiryCandles: number;
  /**
   * When true, a trade requires a *measured* volatility regime. It deliberately
   * does not say which regime: v1 required LOW_VOL to go long and HIGH_VOL to go
   * short, which is a directional bias wearing a volatility filter's costume. It
   * also forbade longs in exactly the conditions where momentum scalping pays.
   */
  requireRegime: boolean;
  /** Displacement from VWAP, in ATR units, below which a bar is treated as chop. */
  minimumVwapDisplacementAtr: number;
  /** Displacement at which momentum is best confirmed. */
  idealVwapDisplacementAtr: number;
  /** Displacement beyond which entering is chasing an extended move. */
  maximumVwapDisplacementAtr: number;
  /**
   * Whether a slower timeframe may veto an entry.
   *
   * `OFF` restores exactly the v5 behaviour, which is what makes this reversible without a code
   * change: the gate is a configuration decision, and turning it off must not require a deploy.
   */
  htfConfluenceMode: "OFF" | "REQUIRE_AGREEMENT";
  /** Which slower timeframe supplies the bias. Must be strictly slower than the bar being traded. */
  htfConfluenceTimeframe: string;
  /** The EMA period on that slower bar whose side of price defines the bias. */
  htfConfluenceEmaPeriod: number;
  /**
   * What to do when the slower bar, or its EMA, is not there.
   *
   * `ALLOW` is the default and it is a considered choice rather than laziness. Absence is the
   * ordinary state early in a session -- the first 15m bar has not closed until 09:30 IST, and
   * trades fire before then -- so `BLOCK` silently removes the open as well as the chop. It is also
   * the failure mode that has already cost this project once: the ICT four-pillar gate failed
   * closed on a pillar that was never populated and the strategy could never fire at all, which
   * looked like "no setups found" rather than a bug. `BLOCK` is available for whoever wants the
   * stricter reading, but it should be chosen deliberately and its no-trade windows checked.
   */
  htfConfluenceOnMissing: "ALLOW" | "BLOCK";
}

function requiredNumber(raw: Record<string, unknown>, key: string, min = -Infinity, max = Infinity): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Momentum scalp configuration requires a valid numeric ${key} between ${min} and ${max}.`);
  }
  return value;
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Momentum scalp configuration requires a valid string ${key}.`);
  }
  return value.trim();
}

function requiredEnum<const T extends readonly string[]>(
  raw: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = raw[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Momentum scalp configuration requires ${key} to be one of ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

function requiredBoolean(raw: Record<string, unknown>, key: string): boolean {
  if (typeof raw[key] !== "boolean") {
    throw new Error(`Momentum scalp configuration requires a boolean ${key}.`);
  }
  return raw[key] as boolean;
}

function requiredIndicatorParameters(raw: Record<string, unknown>): Record<string, Record<string, number | string | boolean>> {
  const candidate = raw.indicatorParameters;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Momentum scalp configuration requires indicator parameter sets.");
  }
  const result: Record<string, Record<string, number | string | boolean>> = {};
  for (const code of ["EMA_FAST", "EMA_SLOW", "RSI", "VWAP", "ATR"]) {
    const parameters = (candidate as Record<string, unknown>)[code];
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length === 0) {
      throw new Error(`Momentum scalp configuration requires parameters for ${code}.`);
    }
    const typed: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
        throw new Error(`Momentum scalp configuration has an unsupported parameter for ${code}.`);
      }
      typed[key] = value;
    }
    result[code] = typed;
  }
  return result;
}

export function parseMomentumScalpStrategyConfiguration(raw: Record<string, unknown>): MomentumScalpStrategyConfiguration {
  const configuration: MomentumScalpStrategyConfiguration = {
    indicatorAlgorithmVersion: requiredString(raw, "indicatorAlgorithmVersion"),
    indicatorParameters: requiredIndicatorParameters(raw),
    candlestickAlgorithmVersion: requiredString(raw, "candlestickAlgorithmVersion"),
    priceActionAlgorithmVersion: requiredString(raw, "priceActionAlgorithmVersion"),
    rsiLongMin: requiredNumber(raw, "rsiLongMin", 0, 100),
    rsiLongMax: requiredNumber(raw, "rsiLongMax", 0, 100),
    rsiShortMin: requiredNumber(raw, "rsiShortMin", 0, 100),
    rsiShortMax: requiredNumber(raw, "rsiShortMax", 0, 100),
    atrStopMultiple: requiredNumber(raw, "atrStopMultiple", Number.EPSILON),
    rewardRiskMultiple: requiredNumber(raw, "rewardRiskMultiple", Number.EPSILON),
    minimumConfidence: requiredNumber(raw, "minimumConfidence", 0, 1),
    expiryCandles: requiredNumber(raw, "expiryCandles", 1),
    requireRegime: requiredBoolean(raw, "requireRegime"),
    minimumVwapDisplacementAtr: requiredNumber(raw, "minimumVwapDisplacementAtr", 0),
    idealVwapDisplacementAtr: requiredNumber(raw, "idealVwapDisplacementAtr", Number.EPSILON),
    maximumVwapDisplacementAtr: requiredNumber(raw, "maximumVwapDisplacementAtr", Number.EPSILON),
    htfConfluenceMode: requiredEnum(raw, "htfConfluenceMode", ["OFF", "REQUIRE_AGREEMENT"] as const),
    htfConfluenceTimeframe: requiredString(raw, "htfConfluenceTimeframe"),
    htfConfluenceEmaPeriod: requiredNumber(raw, "htfConfluenceEmaPeriod", 1),
    htfConfluenceOnMissing: requiredEnum(raw, "htfConfluenceOnMissing", ["ALLOW", "BLOCK"] as const),
  };
  if (configuration.rsiLongMax <= configuration.rsiLongMin) {
    throw new Error("Momentum scalp configuration requires rsiLongMax to be greater than rsiLongMin.");
  }
  if (configuration.rsiShortMax <= configuration.rsiShortMin) {
    throw new Error("Momentum scalp configuration requires rsiShortMax to be greater than rsiShortMin.");
  }
  // The displacement score interpolates between these three points, so a
  // non-monotonic set would silently produce a negative or divide-by-zero score.
  if (
    !(configuration.minimumVwapDisplacementAtr < configuration.idealVwapDisplacementAtr)
    || !(configuration.idealVwapDisplacementAtr < configuration.maximumVwapDisplacementAtr)
  ) {
    throw new Error(
      "Momentum scalp configuration requires minimumVwapDisplacementAtr < idealVwapDisplacementAtr < maximumVwapDisplacementAtr.",
    );
  }
  return configuration;
}

interface ResolvedIndicators {
  emaFast: IndicatorSnapshot;
  emaSlow: IndicatorSnapshot;
  rsi: IndicatorSnapshot;
  vwap: IndicatorSnapshot;
  atr: IndicatorSnapshot;
  emaFastValue: number;
  emaSlowValue: number;
  rsiValue: number;
  vwapValue: number;
  atrValue: number;
}

function findIndicator(context: StrategyMarketContext, code: string, algorithmVersion: string, parameters: Record<string, number | string | boolean>): IndicatorSnapshot | null {
  for (const indicator of context.indicators) {
    if (indicator.code !== code || indicator.algorithmVersion !== algorithmVersion) continue;
    let match = true;
    for (const [key, value] of Object.entries(parameters)) {
      if (indicator.parameters[key] !== value) {
        match = false;
        break;
      }
    }
    if (match) return indicator;
  }
  return null;
}

function indicatorNumber(values: Record<string, unknown>, key: string): number | null {
  return typeof values[key] === "number" ? values[key] as number : null;
}

function resolveIndicators(context: StrategyMarketContext, configuration: MomentumScalpStrategyConfiguration): ResolvedIndicators | null {
  const emaFast = findIndicator(context, "EMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.EMA_FAST);
  const emaSlow = findIndicator(context, "EMA", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.EMA_SLOW);
  const rsi = findIndicator(context, "RSI", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.RSI);
  const vwap = findIndicator(context, "VWAP", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.VWAP);
  const atr = findIndicator(context, "ATR", configuration.indicatorAlgorithmVersion, configuration.indicatorParameters.ATR);

  if (!emaFast || !emaSlow || !rsi || !vwap || !atr) return null;

  const emaFastValue = indicatorNumber(emaFast.values, "value");
  const emaSlowValue = indicatorNumber(emaSlow.values, "value");
  const rsiValue = indicatorNumber(rsi.values, "value");
  const vwapValue = indicatorNumber(vwap.values, "value");
  const atrValue = indicatorNumber(atr.values, "value");

  if (emaFastValue === null || emaSlowValue === null || rsiValue === null || vwapValue === null || atrValue === null || atrValue <= 0) return null;
  return { emaFast, emaSlow, rsi, vwap, atr, emaFastValue, emaSlowValue, rsiValue, vwapValue, atrValue };
}

/**
 * Signed displacement from VWAP in ATR units, positive when it favours the side.
 * ATR normalises it so the same number means the same thing across instruments
 * and across a volatility regime change.
 */
function vwapDisplacementAtr(closePrice: number, vwapValue: number, atrValue: number, side: TradeSide): number {
  const signed = side === "LONG" ? closePrice - vwapValue : vwapValue - closePrice;
  return signed / atrValue;
}

/**
 * Scores displacement as a plateau, not a ramp.
 *
 * Below `minimum` the bar has not displaced and is chop. Between `minimum` and
 * `ideal` the move is confirming. Above `ideal` quality decays, reaching zero at
 * `maximum`, because entering an already-extended move is chasing.
 */
function vwapDisplacementScore(displacementAtr: number, configuration: MomentumScalpStrategyConfiguration): number {
  const { minimumVwapDisplacementAtr: near, idealVwapDisplacementAtr: ideal, maximumVwapDisplacementAtr: far } = configuration;
  if (!Number.isFinite(displacementAtr) || displacementAtr <= near || displacementAtr >= far) return 0;
  if (displacementAtr < ideal) return clamp((displacementAtr - near) / (ideal - near));
  return clamp((far - displacementAtr) / (far - ideal));
}

/**
 * Scores where RSI sits inside its momentum band, peaking mid-band.
 *
 * Both edges are lower quality for opposite reasons: the near edge is momentum
 * that has not established itself, and the far edge is exhaustion.
 */
function rsiMomentumScore(rsiValue: number, side: TradeSide, configuration: MomentumScalpStrategyConfiguration): number {
  const low = side === "LONG" ? configuration.rsiLongMin : configuration.rsiShortMin;
  const high = side === "LONG" ? configuration.rsiLongMax : configuration.rsiShortMax;
  if (!(high > low)) return 0;
  const position = (rsiValue - low) / (high - low);
  return clamp(1 - Math.abs(position - 0.5) * 2);
}

interface ConfidenceBreakdown {
  confidence: number;
  emaSpreadScore: number;
  displacementScore: number;
  rsiScore: number;
  displacementAtr: number;
}

/**
 * The higher-timeframe veto, resolved once per bar and reused for both sides.
 *
 * Every outcome is named rather than collapsed to a boolean, because "the slower bar disagreed"
 * and "there was no slower bar" are different facts and a gate that cannot tell them apart is how
 * a permanently-unpopulated input turns into a strategy that silently never fires.
 */
type HtfGateOutcome =
  | { readonly status: "DISABLED" }
  /** Configured against a timeframe that is not strictly slower than the one being traded. */
  | { readonly status: "NOT_HIGHER"; readonly configured: string }
  /** No slower context attached, or it carries no usable EMA. */
  | { readonly status: "UNAVAILABLE"; readonly configured: string }
  | {
    readonly status: "RESOLVED";
    readonly configured: string;
    readonly bias: HtfBias;
    readonly htfClose: number;
    readonly emaPeriod: number;
  };

function resolveHtfGate(
  context: StrategyMarketContext,
  configuration: MomentumScalpStrategyConfiguration,
): HtfGateOutcome {
  const configured = configuration.htfConfluenceTimeframe;
  if (configuration.htfConfluenceMode === "OFF") return { status: "DISABLED" };
  // Scoring a bar against itself, or against something faster, manufactures agreement out of
  // nothing. Treated as a configuration fault rather than silently passing.
  if (!isStrictlyHigherTimeframe(context.candle.timeframe, configured)) {
    return { status: "NOT_HIGHER", configured };
  }

  const htf = context.higherTimeframeContexts?.[configured as keyof NonNullable<typeof context.higherTimeframeContexts>];
  if (!htf) return { status: "UNAVAILABLE", configured };
  const bias = htfBiasFrom(htf, configuration.indicatorAlgorithmVersion, configuration.htfConfluenceEmaPeriod);
  if (bias === null) return { status: "UNAVAILABLE", configured };
  return {
    status: "RESOLVED",
    configured,
    bias,
    htfClose: htf.candle.close,
    emaPeriod: configuration.htfConfluenceEmaPeriod,
  };
}

/**
 * `NOT_HIGHER` blocks unconditionally, and does not consult `htfConfluenceOnMissing`. That setting
 * governs missing data; a timeframe that is not actually higher is a misconfiguration, and letting
 * `ALLOW` wave it through would turn a typo into a silently ungated strategy.
 */
function htfGateAllows(
  outcome: HtfGateOutcome,
  side: TradeSide,
  configuration: MomentumScalpStrategyConfiguration,
): boolean {
  switch (outcome.status) {
    case "DISABLED": return true;
    case "NOT_HIGHER": return false;
    case "UNAVAILABLE": return configuration.htfConfluenceOnMissing === "ALLOW";
    // A NEUTRAL bias -- an exact close-equals-EMA tie -- agrees with neither side and so blocks
    // under REQUIRE_AGREEMENT. Measure-zero in practice; spelled out so it is not a surprise.
    case "RESOLVED": return biasAgreesWith(outcome.bias, side);
  }
}

/**
 * Confidence in [0.30, 1.00].
 *
 * v1 used `0.7 - vwapDistance * 0.2`, which had two defects. Its range was
 * [0.50, 0.70] against a 0.50 floor, so the quality gate could never reject
 * anything and section-11 trade filtering was a no-op. And it *decreased* with
 * distance from VWAP even though the entry rule already required price to be on
 * the correct side of VWAP -- so it ranked a bar hovering a tick above VWAP,
 * which is chop, above a bar that had actually displaced. Momentum wants
 * confirmed displacement, bounded by an anti-chase ceiling.
 */
function confidenceFor(
  context: StrategyMarketContext,
  configuration: MomentumScalpStrategyConfiguration,
  indicators: ResolvedIndicators,
  side: TradeSide,
): ConfidenceBreakdown {
  const displacementAtr = vwapDisplacementAtr(context.candle.close, indicators.vwapValue, indicators.atrValue, side);
  const displacementScore = vwapDisplacementScore(displacementAtr, configuration);
  const emaSpreadScore = clamp(Math.abs(indicators.emaFastValue - indicators.emaSlowValue) / indicators.atrValue);
  const rsiScore = rsiMomentumScore(indicators.rsiValue, side, configuration);
  const confidence = clamp(0.3 + emaSpreadScore * 0.25 + displacementScore * 0.25 + rsiScore * 0.2);
  return { confidence, emaSpreadScore, displacementScore, rsiScore, displacementAtr };
}

function buildProposal(
  context: StrategyMarketContext,
  configuration: MomentumScalpStrategyConfiguration,
  indicators: ResolvedIndicators,
  side: TradeSide,
  htfGate: HtfGateOutcome,
): ProposedTradeIdea | null {
  // Applied before any geometry is computed: a vetoed setup should cost nothing and, more
  // importantly, must not be able to reach the proposal path at all.
  if (!htfGateAllows(htfGate, side, configuration)) return null;

  const tickSize = context.candle.tickSize;
  if (!Number.isFinite(tickSize) || tickSize <= 0 || context.candle.close <= 0) return null;

  const barMilliseconds = timeframeMilliseconds(context.candle.timeframe);
  // v1 fell back to 0 here, which set expiresAt equal to closeTime and produced
  // an idea that was already expired the moment it was written.
  if (barMilliseconds === null) return null;

  const scores = confidenceFor(context, configuration, indicators, side);
  // Displacement is a hard gate, not only a soft score. A bar that has not
  // displaced past `minimum`, or has run past `maximum`, is rejected outright so
  // that "never chase" is a rule rather than a preference the other terms can
  // outvote.
  if (scores.displacementScore <= 0) return null;
  if (scores.confidence < configuration.minimumConfidence) return null;

  const entryPrice = roundNearestToTick(context.candle.close, tickSize);
  const rawStopDistance = Math.max(tickSize, indicators.atrValue * configuration.atrStopMultiple);
  const stopLoss = side === "LONG"
    ? roundDownToTick(entryPrice - rawStopDistance, tickSize)
    : roundUpToTick(entryPrice + rawStopDistance, tickSize);
  if (stopLoss <= 0 || (side === "LONG" && stopLoss >= entryPrice) || (side === "SHORT" && stopLoss <= entryPrice)) return null;

  const risk = Math.abs(entryPrice - stopLoss);
  const targetPrice = side === "LONG"
    ? roundUpToTick(entryPrice + risk * configuration.rewardRiskMultiple, tickSize)
    : roundDownToTick(entryPrice - risk * configuration.rewardRiskMultiple, tickSize);
  if (targetPrice <= 0 || (side === "LONG" && targetPrice <= entryPrice) || (side === "SHORT" && targetPrice >= entryPrice)) return null;

  const riskReward = rounded(Math.abs(targetPrice - entryPrice) / risk);
  const expiresAt = new Date(context.candle.closeTime.getTime() + barMilliseconds * configuration.expiryCandles);

  const evidenceItems: TradeIdeaEvidence[] = [
    {
      sourceType: "INDICATOR",
      sourceReference: `EMA:${indicators.emaFast.algorithmVersion}`,
      label: `Fast EMA ${indicators.emaFastValue.toFixed(2)} is ${side === "LONG" ? "above" : "below"} slow EMA ${indicators.emaSlowValue.toFixed(2)} by ${rounded(scores.emaSpreadScore)} ATR`,
      contribution: rounded(scores.emaSpreadScore * 0.25),
      details: {
        fast: indicators.emaFastValue,
        slow: indicators.emaSlowValue,
        spreadAtr: rounded(scores.emaSpreadScore),
        close: context.candle.close,
      },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `VWAP:${indicators.vwap.algorithmVersion}`,
      label: `Price is displaced ${rounded(scores.displacementAtr)} ATR ${side === "LONG" ? "above" : "below"} VWAP ${indicators.vwapValue.toFixed(2)}`,
      contribution: rounded(scores.displacementScore * 0.25),
      details: {
        value: indicators.vwapValue,
        close: context.candle.close,
        displacementAtr: rounded(scores.displacementAtr),
        minimumAtr: configuration.minimumVwapDisplacementAtr,
        idealAtr: configuration.idealVwapDisplacementAtr,
        maximumAtr: configuration.maximumVwapDisplacementAtr,
      },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `RSI:${indicators.rsi.algorithmVersion}`,
      label: `RSI ${indicators.rsiValue.toFixed(2)} sits inside the ${side === "LONG" ? `${configuration.rsiLongMin}-${configuration.rsiLongMax}` : `${configuration.rsiShortMin}-${configuration.rsiShortMax}`} momentum band`,
      contribution: rounded(scores.rsiScore * 0.2),
      details: { value: indicators.rsiValue, close: context.candle.close },
    },
    {
      sourceType: "INDICATOR",
      sourceReference: `ATR:${indicators.atr.algorithmVersion}`,
      label: `ATR is ${indicators.atrValue.toFixed(2)}, setting a ${rounded(risk)} point stop distance`,
      contribution: null,
      details: { value: indicators.atrValue, stopDistance: rounded(risk) },
    },
    {
      sourceType: "STRATEGY" as const,
      sourceReference: `momentum-scalp:v${momentumScalpStrategyVersion}`,
      label: `Momentum Scalp v${momentumScalpStrategyVersion} rule set passed`,
      contribution: null,
      details: {
        configuration,
        sourceCandleId: context.candle.id,
        timeframe: context.candle.timeframe,
        entryPrice,
        stopLoss,
        targetPrice,
        riskReward,
        confidence: scores.confidence,
        confidenceTerms: {
          base: 0.3,
          emaSpread: rounded(scores.emaSpreadScore * 0.25),
          vwapDisplacement: rounded(scores.displacementScore * 0.25),
          rsiMomentum: rounded(scores.rsiScore * 0.2),
        },
        expiresAt: expiresAt.toISOString(),
      },
    },
  ];

  if (htfGate.status !== "DISABLED") {
    evidenceItems.push({
      sourceType: "INDICATOR" as const,
      sourceReference: `HTF:${htfGate.configured}`,
      label: htfGate.status === "RESOLVED"
        ? `Higher timeframe ${htfGate.configured} is ${htfGate.bias} (close ${htfGate.htfClose.toFixed(2)} vs EMA${htfGate.emaPeriod}), agreeing with a ${side}`
        : `Higher timeframe ${htfGate.configured} bias was ${htfGate.status}, admitted under htfConfluenceOnMissing=${configuration.htfConfluenceOnMissing}`,
      // The gate is a veto, not a term in the confidence formula. Claiming a numeric contribution
      // would over-attribute a confidence this did not move -- the same reason `regime` reports null.
      contribution: null,
      details: {
        mode: configuration.htfConfluenceMode,
        timeframe: htfGate.configured,
        status: htfGate.status,
        onMissing: configuration.htfConfluenceOnMissing,
        ...(htfGate.status === "RESOLVED"
          ? { bias: htfGate.bias, htfClose: htfGate.htfClose, emaPeriod: htfGate.emaPeriod }
          : {}),
      },
    });
  }

  if (context.regime) {
    evidenceItems.push({
      sourceType: "REGIME" as const,
      sourceReference: "VIX_SMA20",
      label: `Volatility regime is ${context.regime.regime}`,
      // The regime is a gate, not a term in the confidence formula. Claiming a
      // numeric contribution here would over-attribute the computed confidence.
      contribution: null,
      details: {
        regime: context.regime.regime,
        valueRatio: rounded(context.regime.valueRatio),
      },
    });
  }

  const labelSide = side === "LONG" ? "BULLISH" : "BEARISH";
  return {
    side,
    entryPrice,
    stopLoss,
    targetPrice,
    riskReward,
    confidence: scores.confidence,
    reasoning: [
      `${labelSide} Momentum Scalp entry on ${context.candle.timeframe}.`,
      `Fast EMA is ${side === "LONG" ? "above" : "below"} slow EMA by ${rounded(scores.emaSpreadScore)} ATR, and price has displaced ${rounded(scores.displacementAtr)} ATR ${side === "LONG" ? "above" : "below"} VWAP.`,
      `RSI ${indicators.rsiValue.toFixed(2)} is inside the momentum band and short of the exhaustion edge.`,
      `Reference entry ${entryPrice.toFixed(2)}, stop ${stopLoss.toFixed(2)}, target ${targetPrice.toFixed(2)} (${riskReward.toFixed(2)}R).`,
    ],
    evidence: {
      strategy: "momentum-scalp",
      strategyVersion: momentumScalpStrategyVersion,
      sourceCandleId: context.candle.id,
      sourceCandleClose: context.candle.close,
      indicatorAlgorithmVersion: configuration.indicatorAlgorithmVersion,
      candlestickAlgorithmVersion: configuration.candlestickAlgorithmVersion,
      priceActionAlgorithmVersion: configuration.priceActionAlgorithmVersion,
      regime: context.regime?.regime ?? null,
    },
    expiresAt,
    evidenceItems,
  };
}

export class MomentumScalpStrategy {
  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const configuration = parseMomentumScalpStrategyConfiguration(rawConfiguration);
    const indicators = resolveIndicators(context, configuration);
    if (!indicators) return [];

    // A measured regime may be required, but it never selects the direction.
    const regime: VolatilityRegime | null = context.regime?.regime ?? null;
    if (configuration.requireRegime && regime === null) return [];

    // Resolved once and shared by both sides: the slower bar's bias does not depend on which
    // direction we are testing, and resolving twice would invite the two to drift apart.
    const htfGate = resolveHtfGate(context, configuration);

    const longConditions = context.candle.close > indicators.vwapValue
      && indicators.emaFastValue > indicators.emaSlowValue
      && indicators.rsiValue >= configuration.rsiLongMin
      && indicators.rsiValue <= configuration.rsiLongMax;

    if (longConditions) {
      const proposal = buildProposal(context, configuration, indicators, "LONG", htfGate);
      if (proposal) return [proposal];
    }

    const shortConditions = context.candle.close < indicators.vwapValue
      && indicators.emaFastValue < indicators.emaSlowValue
      && indicators.rsiValue >= configuration.rsiShortMin
      && indicators.rsiValue <= configuration.rsiShortMax;

    if (shortConditions) {
      const proposal = buildProposal(context, configuration, indicators, "SHORT", htfGate);
      if (proposal) return [proposal];
    }

    return [];
  }
}
