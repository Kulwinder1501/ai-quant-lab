import { describe, expect, it } from "vitest";
import { scoreDirectionalSetup, type DirectionalSetupInput } from "./directional-setup-score.js";
import { institutionalFlowBias } from "../application/ai-autonomous-agent.js";

/** A neutral setup: mid-band price, RSI at 50, no pattern, no flow, no news, no macro flag. */
function baseInput(overrides: Partial<DirectionalSetupInput> = {}): DirectionalSetupInput {
  return {
    rsi: 50,
    livePrice: 24_000,
    bollingerUpper: 24_500,
    bollingerLower: 23_500,
    pattern: null,
    flowBias: { long: { adjustment: 0, reasoning: null }, short: { adjustment: 0, reasoning: null } },
    newsSentiment: 0,
    newsLabel: "NEUTRAL (No breaking news in last 12h)",
    hasHeadlineHeat: false,
    headlineEventNames: [],
    ...overrides,
  };
}

/** Mirrors what the agent does: the short verdict is the same function on negated flows. */
function flowBiasFor(fii: number, dii: number) {
  return {
    long: institutionalFlowBias(fii, dii),
    short: institutionalFlowBias(-fii, -dii),
  };
}

describe("scoreDirectionalSetup", () => {
  it("scores a neutral setup at the base plus the in-envelope term, on both sides", () => {
    const result = scoreDirectionalSetup(baseInput());
    // 50 base + 10 for sitting inside the envelope. Identical both ways, so LONG wins the tie.
    expect(result.longConfidence).toBe(60);
    expect(result.shortConfidence).toBe(60);
    expect(result.side).toBe("LONG");
  });

  it("keeps the long side's numbers identical to the long-only version", () => {
    // Regression pin for the extraction. Pre-existing weights: 50 base, +15 RSI in the healthy
    // band, +10 in-envelope, +20 agreeing pattern, +10 positive news = 105, clamped to the 96
    // ceiling the long-only version also applied.
    const result = scoreDirectionalSetup(baseInput({
      rsi: 60,
      pattern: { code: "BULLISH_ENGULFING", direction: "BULLISH", confidence: 0.9 },
      newsSentiment: 0.3,
    }));
    expect(result.longConfidence).toBe(96);
    expect(result.side).toBe("LONG");

    // And without the clamp in play, the sum is exact: 50 + 15 + 10 + 10 = 85.
    const unclamped = scoreDirectionalSetup(baseInput({ rsi: 60, newsSentiment: 0.3 }));
    expect(unclamped.longConfidence).toBe(85);
  });

  it("picks SHORT when the evidence is bearish, and the score is the one computed for SHORT", () => {
    // The exact case that used to misfire: a strong bearish pattern raised the *bullish* score
    // by 20 and then flipped the side, so the position traded on a number built for a long.
    const result = scoreDirectionalSetup(baseInput({
      rsi: 40, // Healthy downward momentum for a short; nothing for a long.
      pattern: { code: "BEARISH_ENGULFING", direction: "BEARISH", confidence: 0.95 },
      newsSentiment: -0.3,
    }));

    expect(result.side).toBe("SHORT");
    expect(result.confidence).toBe(result.shortConfidence);
    expect(result.shortConfidence).toBeGreaterThan(result.longConfidence);
    // And the reasoning it carries is the short thesis's, not the long's.
    expect(result.reasoning.some((line) => /downward momentum/.test(line))).toBe(true);
  });

  it("is symmetric: mirroring the evidence mirrors the verdict", () => {
    const bullish = scoreDirectionalSetup(baseInput({
      rsi: 60,
      pattern: { code: "BULLISH_ENGULFING", direction: "BULLISH", confidence: 0.9 },
    }));
    const bearish = scoreDirectionalSetup(baseInput({
      rsi: 40,
      pattern: { code: "BEARISH_ENGULFING", direction: "BEARISH", confidence: 0.9 },
    }));

    expect(bullish.side).toBe("LONG");
    expect(bearish.side).toBe("SHORT");
    expect(bearish.shortConfidence).toBe(bullish.longConfidence);
  });

  it("applies SMC as the same bounded directional term to both theses", () => {
    const bullish = scoreDirectionalSetup(baseInput({
      smcBias: {
        long: { adjustment: 8, reasoning: "Bullish SMC." },
        short: { adjustment: -8, reasoning: "Bullish SMC opposes short." },
      },
    }));
    const bearish = scoreDirectionalSetup(baseInput({
      smcBias: {
        long: { adjustment: -8, reasoning: "Bearish SMC opposes long." },
        short: { adjustment: 8, reasoning: "Bearish SMC." },
      },
    }));

    expect(bullish.longConfidence).toBe(68);
    expect(bullish.shortConfidence).toBe(52);
    expect(bearish.longConfidence).toBe(52);
    expect(bearish.shortConfidence).toBe(68);
  });

  it("freezes a long on heavy negative news and a short on heavy positive news", () => {
    const crashing = scoreDirectionalSetup(baseInput({ newsSentiment: -0.8 }));
    expect(crashing.longConfidence).toBeLessThan(30);

    const melting = scoreDirectionalSetup(baseInput({ newsSentiment: 0.8 }));
    expect(melting.shortConfidence).toBeLessThan(30);
  });

  it("does not let extreme news alone push the opposite side to a proposal", () => {
    // Removing a brake must not be the same as adding conviction: a crash is not by itself a
    // reason to short at 80%, or the breaker would become a short trigger.
    const crashing = scoreDirectionalSetup(baseInput({ newsSentiment: -0.9 }));
    expect(crashing.shortConfidence).toBeLessThan(80);
  });

  it("applies driver-tape soft bias when present and leaves scores unchanged when omitted", () => {
    const plain = scoreDirectionalSetup(baseInput({ rsi: 60 }));
    const withTape = scoreDirectionalSetup(baseInput({
      rsi: 60,
      driverTapeBias: {
        long: { adjustment: -12, reasoning: "Driver tape weak for LONG: only 30% agree." },
        short: { adjustment: 8, reasoning: "Driver tape supports SHORT." },
      },
    }));
    expect(withTape.longConfidence).toBe(plain.longConfidence - 12);
    expect(withTape.shortConfidence).toBe(plain.shortConfidence + 8);
    // SHORT wins after the tape tilt, so the winner's reasoning carries the short line.
    expect(withTape.side).toBe("SHORT");
    expect(withTape.reasoning.some((line) => /Driver tape supports SHORT/.test(line))).toBe(true);
  });

  it("weights adverse institutional flow more heavily than confirming flow, on both sides", () => {
    // Extreme outflows: -18 * 1.5 against a long, +18 for a short.
    const outflows = scoreDirectionalSetup(baseInput({ flowBias: flowBiasFor(-6_000, -1_000) }));
    expect(outflows.longConfidence).toBe(60 - 27);
    expect(outflows.shortConfidence).toBe(60 + 18);

    // And the reverse, so neither side gets the milder weighting systematically.
    const inflows = scoreDirectionalSetup(baseInput({ flowBias: flowBiasFor(6_000, 1_000) }));
    expect(inflows.longConfidence).toBe(60 + 18);
    expect(inflows.shortConfidence).toBe(60 - 27);
  });

  it("discounts both sides equally for a headline-derived macro flag", () => {
    const withMacro = scoreDirectionalSetup(baseInput({
      hasHeadlineHeat: true,
      headlineEventNames: ["monetary policy"],
    }));
    const withoutMacro = scoreDirectionalSetup(baseInput());

    expect(withoutMacro.longConfidence - withMacro.longConfidence).toBe(10);
    expect(withoutMacro.shortConfidence - withMacro.shortConfidence).toBe(10);
  });

  it("applies the false-breakout penalty to the side pressing into its own risk edge", () => {
    // At the upper band the long is the one buying resistance, so only it takes the -25.
    // Neither band term fires at a price exactly *on* the band -- "pierced" and "touched" both
    // need price beyond it -- which is why this asserts the edge penalty rather than a touch.
    const atUpper = scoreDirectionalSetup(baseInput({ livePrice: 24_500 }));
    expect(atUpper.longConfidence).toBe(50 - 25);
    expect(atUpper.shortConfidence).toBe(50);
    expect(atUpper.side).toBe("SHORT");
    expect(atUpper.reasoning.some((line) => /false breakout/.test(line))).toBe(false);

    // And the mirror at the lower band.
    const atLower = scoreDirectionalSetup(baseInput({ livePrice: 23_500 }));
    expect(atLower.shortConfidence).toBe(50 - 25);
    expect(atLower.longConfidence).toBe(50);
    expect(atLower.side).toBe("LONG");
  });

  it("reads a decisive break beyond a band as opportunity for one side and risk for the other", () => {
    // Strictly beyond the upper band, a long takes both band penalties -- it has pierced its risk
    // band (-10) *and* it is sitting on resistance (-25). The two are separate checks in the
    // long-only original as well, so the doubling is pre-existing behaviour, not new. The short
    // meanwhile has touched its opportunity band (+15).
    const brokenUp = scoreDirectionalSetup(baseInput({ livePrice: 24_600 }));
    expect(brokenUp.longConfidence).toBe(50 - 10 - 25);
    expect(brokenUp.shortConfidence).toBe(50 + 15);
    expect(brokenUp.side).toBe("SHORT");
    expect(brokenUp.reasoning.some((line) => /upper Bollinger Band/.test(line))).toBe(true);

    const brokenDown = scoreDirectionalSetup(baseInput({ livePrice: 23_400 }));
    expect(brokenDown.longConfidence).toBe(50 + 15);
    expect(brokenDown.shortConfidence).toBe(50 - 10 - 25);
    expect(brokenDown.side).toBe("LONG");
  });

  it("clamps each thesis into the reported band rather than returning a raw sum", () => {
    const contradicted = scoreDirectionalSetup(baseInput({
      rsi: 85,
      livePrice: 24_500,
      pattern: { code: "BEARISH_ENGULFING", direction: "BEARISH", confidence: 0.95 },
      newsSentiment: -0.9,
      hasHeadlineHeat: true,
      headlineEventNames: ["policy"],
      flowBias: flowBiasFor(-8_000, -2_000),
    }));
    expect(contradicted.longConfidence).toBeGreaterThanOrEqual(15);
    expect(contradicted.shortConfidence).toBeLessThanOrEqual(96);
  });

  describe("bandBias: MOMENTUM inverts only the Bollinger term", () => {
    // A bar with price above the upper band. Mean-reversion reads this as a short opportunity
    // (sell the rip); momentum reads it as a long opportunity (buy the breakout). Nothing else in
    // the input favours either side, so the band term alone must drive the difference.
    const aboveUpper = { rsi: 50, livePrice: 24_600, bollingerUpper: 24_500, bollingerLower: 23_500 };

    it("defaults to mean-reversion when bandBias is absent", () => {
      const withFlag = scoreDirectionalSetup(baseInput({ ...aboveUpper, bandBias: "MEAN_REVERSION" }));
      const without = scoreDirectionalSetup(baseInput({ ...aboveUpper }));
      expect(withFlag.longConfidence).toBe(without.longConfidence);
      expect(withFlag.shortConfidence).toBe(without.shortConfidence);
    });

    it("above the upper band, mean-reversion favours the short and momentum favours the long", () => {
      const meanRev = scoreDirectionalSetup(baseInput({ ...aboveUpper, bandBias: "MEAN_REVERSION" }));
      const momentum = scoreDirectionalSetup(baseInput({ ...aboveUpper, bandBias: "MOMENTUM" }));
      // Mean-reversion: price pierced the upper band -> adverse to a long, opportunity for a short.
      expect(meanRev.shortConfidence).toBeGreaterThan(meanRev.longConfidence);
      // Momentum: the same breakout is now the long's opportunity and the short's risk.
      expect(momentum.longConfidence).toBeGreaterThan(momentum.shortConfidence);
      // The flip is a genuine reassignment, not a rescale: the long gains exactly what it lost.
      expect(momentum.longConfidence).toBe(meanRev.shortConfidence);
      expect(momentum.shortConfidence).toBe(meanRev.longConfidence);
    });

    it("keeps the point budget identical, so the comparison isolates the sign", () => {
      // Sum of both theses is invariant under the flip: the same magnitudes, reassigned.
      const meanRev = scoreDirectionalSetup(baseInput({ ...aboveUpper, bandBias: "MEAN_REVERSION" }));
      const momentum = scoreDirectionalSetup(baseInput({ ...aboveUpper, bandBias: "MOMENTUM" }));
      expect(momentum.longConfidence + momentum.shortConfidence)
        .toBe(meanRev.longConfidence + meanRev.shortConfidence);
    });
  });
});
