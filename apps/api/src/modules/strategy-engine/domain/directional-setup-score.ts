import type { TradeSide } from "./strategy.js";

/**
 * Scores a setup for **both** directions, and returns the side the evidence actually supports.
 *
 * Why this exists as its own module. The agent's scorer was a 90-line run of `confidence += n`
 * statements, every one of them written for a long: the institutional-flow term says so in its
 * own contract, oversold RSI added, a lower-band touch added, and Circuit Breaker Rule 1 called
 * itself "freezing new long trade proposals". The side was then chosen *after* the fact from the
 * latest pattern's direction, so a bearish pattern inverted the position while keeping a score
 * built for the opposite thesis -- the agent's most confident shorts were its most confidently
 * bullish reads. The first fix was to make the agent long-only, which was honest but gave up the
 * short side entirely.
 *
 * So each term is now evaluated against a *stated* thesis, and both theses are scored from the
 * same evidence. The side with the stronger score wins, and the number the winner carries is the
 * number that was computed for the direction actually traded.
 *
 * ## Measured: the short side is actively harmful, the long side is neutral
 *
 * `npm run measure:directional-scorer` replays it over stored history, applies the agent's own ATR
 * bracket, and resolves each one with the paper-trading exit rules. On 15m with news/flow/macro
 * held out, patterns current as of 2026-08-10, against a 0.3333 break-even hit rate:
 *
 * | instrument | side  | gated hit (n) | gated expectancy | unconditional | delta   |
 * |------------|-------|---------------|------------------|---------------|---------|
 * | NIFTY50    | LONG  | 0.3351 (367)  | +0.005R          | 0.3370        | -0.0019 |
 * | NIFTY50    | SHORT | 0.2950 (261)  | **-0.262R**      | 0.3595        | -0.0645 |
 * | BANKNIFTY  | LONG  | 0.3850 (413)  | +0.182R          | 0.3568        | +0.0282 |
 * | BANKNIFTY  | SHORT | 0.2478 (347)  | **-0.376R**      | 0.3315        | -0.0837 |
 *
 * The comparison that matters is gated against **unconditional** -- taking that side on every bar
 * regardless of score. The short gate is below break-even on both instruments, strongly negative
 * in expectancy, and 6-8 points worse than its own baseline: it does not merely fail to select, it
 * reliably selects *bad* shorts. So `AGENT_EXECUTABLE_SIDES` in the agent excludes SHORT. It is
 * still scored and journalled; it is not traded.
 *
 * The long gate is roughly neutral -- positive expectancy on both instruments but inconsistent in
 * sign against its baseline, so no edge is claimed and none is needed for it to stay enabled.
 *
 * Two limits on the reading, both real:
 *
 * - With news and flow held out the ceiling is 75 (50 + 15 RSI + 10 envelope), so **clearing 80
 *   requires a pattern**. The gated population is therefore "bars carrying a >=0.7 pattern", not a
 *   general high-confidence population. Live, news and flow can add 28, so the gate is reachable
 *   without one and the live gated population is wider than the one measured here.
 * - An earlier run of this measurement reported the short side at 0.3829 with *positive*
 *   expectancy, and the conclusion drawn from it was wrong. That run used a stale pattern set:
 *   `analysis:detect-patterns` had no scheduled caller, so NIFTY50 15m detections stopped six days
 *   short of its candles and BANKNIFTY had none at all. Since the gate effectively requires a
 *   pattern, stale patterns move the gated population and can invert the result. Re-measure after
 *   any change to pattern coverage, not only after changes to this file.
 *
 * ## What the code therefore claims
 *
 * That the two sides are *coherent*, not that either is profitable. The value of this module is
 * that the number a position is opened on is the number computed for the direction traded --
 * which was not true before, and was the actual defect. Whether to trade on it at all is a
 * separate decision the measurement above should inform.
 *
 * Structural properties, deliberately preserved:
 *
 * - Bands and weights are unchanged from the long-only version, and no global reweighting is
 *   applied, so **a long scores exactly what it scored before**. Mirroring adds the short side;
 *   it does not retune the long side. A test pins the arithmetic.
 * - The one asymmetry, adverse institutional flow counting 1.5x, is not reimplemented here. It
 *   lives in `institutionalFlowBias`, which is already tested, and the caller supplies that
 *   function's verdict per thesis -- see `DirectionalSetupInput.flowBias`.
 */

/** Never proposes below this, so a fully contradicted setup still reports a floor rather than 0. */
const MINIMUM_CONFIDENCE = 15;
/** Caps the ceiling below 100, matching the long-only version: no setup here is a certainty. */
const MAXIMUM_CONFIDENCE = 96;
const BASE_CONFIDENCE = 50;

/** The pattern-engine confidence a pattern must clear before it counts at all. */
export const PATTERN_CERTAINTY_FLOOR = 0.7;

/** The shape `institutionalFlowBias` returns, restated to avoid importing up into `application/`. */
export interface FlowBiasVerdict {
  adjustment: number;
  reasoning: string | null;
}

export interface DirectionalSetupInput {
  /** RSI(14) at the production algorithm version. */
  rsi: number;
  livePrice: number;
  bollingerUpper: number;
  bollingerLower: number;
  /** The most recent pattern, or null. Ignored below the certainty floor. */
  pattern: { code: string; direction: string; confidence: number } | null;
  /**
   * The institutional-flow verdict **per thesis**.
   *
   * Two verdicts rather than one signed number, because the term is asymmetric: outflows are
   * penalised 1.5x relative to inflows. A short's mirror is therefore not a sign flip -- it is
   * the same function evaluated on negated flows, so that *inflows* take the 1.5x against a
   * short. The caller does that, which keeps the tested implementation the only one.
   */
  flowBias: { long: FlowBiasVerdict; short: FlowBiasVerdict };
  /**
   * Live index-driver tape bias **per thesis** (breadth / concentration).
   * Optional: omitted or null reasoning → no adjustment (same as missing FII).
   */
  driverTapeBias?: { long: FlowBiasVerdict; short: FlowBiasVerdict };
  /** Rolling news sentiment in [-1, 1], and 0 with no articles. */
  newsSentiment: number;
  newsLabel: string;
  /**
   * Soft headline keyword heat only. Scheduled calendar hard-gates live in
   * `validateOptionsEntry` via `hasMacroEvent` from the dated calendar — not here.
   */
  hasHeadlineHeat: boolean;
  headlineEventNames: readonly string[];
}

export interface DirectionalSetupScore {
  side: TradeSide;
  confidence: number;
  reasoning: string[];
  /** Both raw scores, so a near-tie is visible rather than hidden behind the winner. */
  longConfidence: number;
  shortConfidence: number;
}

/**
 * Scores one thesis.
 *
 * Every band below is the long-only original, reflected through 50 for a short where the
 * indicator is centred there (RSI) and through the price for the bands.
 */
function scoreThesis(
  side: TradeSide,
  input: DirectionalSetupInput,
): { confidence: number; reasoning: string[] } {
  const long = side === "LONG";
  const {
    rsi, livePrice, bollingerUpper, bollingerLower, pattern,
    flowBias, driverTapeBias, newsSentiment, newsLabel, hasHeadlineHeat, headlineEventNames,
  } = input;

  let confidence = BASE_CONFIDENCE;
  const reasoning: string[] = [];
  const add = (points: number, reason: string): void => {
    confidence += points;
    reasoning.push(reason);
  };

  // --- Momentum -------------------------------------------------------------------------
  // 52-68 was "healthy momentum without overbought exhaustion" for a long. Reflected, a short
  // wants 32-48. The exhaustion guards keep their original meaning: an overbought tape is
  // adverse to a long, an oversold tape adverse to a short.
  const healthyLow = long ? 52 : 32;
  const healthyHigh = long ? 68 : 48;
  const exhaustion = long ? 70 : 30;
  const valueZone = long ? 35 : 65;

  if (rsi >= healthyLow && rsi <= healthyHigh) {
    add(15, `RSI(14) at ${rsi.toFixed(1)} confirms healthy ${long ? "upward" : "downward"} momentum `
      + `without ${long ? "overbought" : "oversold"} exhaustion.`);
  } else if (long ? rsi > exhaustion : rsi < exhaustion) {
    add(-20, `RSI(14) at ${rsi.toFixed(1)} warns of ${long ? "overbought" : "oversold"} divergence.`);
  } else if (long ? rsi < valueZone : rsi > valueZone) {
    add(10, `RSI(14) at ${rsi.toFixed(1)} indicates `
      + `${long ? "oversold value" : "overbought distribution"} zone.`);
  }

  // --- Mean reversion against the bands -------------------------------------------------
  // A long wants price at the lower band and dislikes it pierced through the upper; a short is
  // the mirror. The band a thesis reaches for is its opportunity, the other its risk.
  const opportunityBand = long ? bollingerLower : bollingerUpper;
  const riskBand = long ? bollingerUpper : bollingerLower;

  if (long ? livePrice > bollingerUpper : livePrice < bollingerLower) {
    add(-10, `Price pierced ${long ? "upper" : "lower"} Bollinger Band (₹${riskBand.toFixed(2)}), `
      + "mean reversion risk elevated.");
  } else if (long ? livePrice < bollingerLower : livePrice > bollingerUpper) {
    add(15, `Price touched ${long ? "lower" : "upper"} Bollinger Band `
      + `(₹${opportunityBand.toFixed(2)}), potential value opportunity.`);
  }

  // The false-breakout penalty. -25 for a long sitting on upper resistance; a short sitting on
  // lower support is the same trap facing the other way.
  const insideEnvelope = livePrice < bollingerUpper * 0.995 && livePrice > bollingerLower * 1.005;
  const atRiskEdge = long
    ? livePrice >= bollingerUpper * 0.995
    : livePrice <= bollingerLower * 1.005;
  if (insideEnvelope) {
    add(10, `Price ₹${livePrice.toFixed(2)} is well-positioned within Bollinger Band envelope `
      + `[₹${bollingerLower.toFixed(0)} - ₹${bollingerUpper.toFixed(0)}].`);
  } else if (atRiskEdge) {
    add(-25, `Penalty applied: price is near `
      + `${long ? "upper Bollinger resistance" : "lower Bollinger support"} `
      + `₹${riskBand.toFixed(2)}. Avoiding false breakout.`);
  }

  // --- Pattern evidence -----------------------------------------------------------------
  // The one genuinely symmetric input: the pattern engine publishes a direction, and agreeing
  // with it is not a new claim in either direction.
  if (pattern && pattern.confidence >= PATTERN_CERTAINTY_FLOOR) {
    const agrees = long ? pattern.direction !== "BEARISH" : pattern.direction === "BEARISH";
    add(agrees ? 20 : -20, `Detected ${pattern.code} (${pattern.direction}) with `
      + `${(pattern.confidence * 100).toFixed(0)}% algorithmic certainty.`);
  }

  // --- Institutional flow ---------------------------------------------------------------
  const bias = long ? flowBias.long : flowBias.short;
  if (bias.reasoning !== null) add(bias.adjustment, bias.reasoning);

  // --- Index-driver tape (breadth / concentration) --------------------------------------
  // Soft context from approximate Yahoo contributions. Missing / thin coverage stays
  // unchecked — same honesty rule as institutional flow.
  const tape = long ? driverTapeBias?.long : driverTapeBias?.short;
  if (tape && tape.reasoning !== null) add(tape.adjustment, tape.reasoning);

  // --- News sentiment -------------------------------------------------------------------
  // Rule 1 is directional: heavy negative news freezes new *longs*, and heavy positive news is
  // the same hazard for a *short*. Note what this does and does not do -- it removes the brake
  // for the side the tape agrees with, but never adds conviction beyond the ordinary agreement
  // points below. Extreme sentiment is not treated as a reason to press the trade.
  const sentimentForThesis = long ? newsSentiment : -newsSentiment;
  if (sentimentForThesis <= -0.5) {
    add(-40, `🚨 CIRCUIT BREAKER RULE 1: Heavy ${long ? "negative" : "positive"} news sentiment `
      + `(${newsSentiment.toFixed(2)}). Freezing new ${long ? "long" : "short"} trade proposals.`);
  } else if (sentimentForThesis > 0.2) {
    add(10, `Indian market macro news sentiment is ${newsLabel}.`);
  } else if (sentimentForThesis < 0) {
    add(-10, `Mild ${long ? "negative" : "positive"} news sentiment `
      + `(${newsSentiment.toFixed(2)}) against a ${side} thesis.`);
  }

  // --- Side-agnostic caution ------------------------------------------------------------
  // Headline keyword heat is uncertainty, not a direction, so it discounts both theses
  // equally. See the note in ai-autonomous-agent.ts on why this is -10 and not a block.
  if (hasHeadlineHeat) {
    add(-10, `Macro-event caution: recent coverage mentions ${headlineEventNames.slice(0, 3).join(", ")}. `
      + "Headline-derived, not a scheduled-event calendar, so treated as context rather than a block.");
  }

  return {
    confidence: Math.min(MAXIMUM_CONFIDENCE, Math.max(MINIMUM_CONFIDENCE, confidence)),
    reasoning,
  };
}

/**
 * Scores both directions and returns the better-supported one.
 *
 * A tie resolves to LONG. That is not a coin toss dressed up as a rule: the long side's bands are
 * the in-use ones and the short side's are their untested reflection, so where the evidence
 * cannot separate them the tested reading wins.
 */
export function scoreDirectionalSetup(input: DirectionalSetupInput): DirectionalSetupScore {
  const longScore = scoreThesis("LONG", input);
  const shortScore = scoreThesis("SHORT", input);
  const side: TradeSide = shortScore.confidence > longScore.confidence ? "SHORT" : "LONG";
  const winner = side === "LONG" ? longScore : shortScore;
  return {
    side,
    confidence: winner.confidence,
    reasoning: winner.reasoning,
    longConfidence: longScore.confidence,
    shortConfidence: shortScore.confidence,
  };
}
