import { describe, expect, it } from "vitest";
import { proposeVolatilityStraddle, type ProposeStraddleInput } from "./volatility-straddle.js";

const NOW = new Date("2026-07-01T04:00:00Z");
const EXPIRY = new Date("2026-07-09T10:00:00Z");

function input(overrides: Partial<ProposeStraddleInput> = {}): ProposeStraddleInput {
  return {
    prediction: "EXPANSION",
    underlyingSymbol: "NIFTY50",
    underlyingSpot: 24_000,
    impliedVolatility: 0.14,
    expiryDate: EXPIRY,
    expirySource: "CONFIRMED",
    strikeStep: 50,
    lotSize: 75,
    lots: 1,
    // Wide enough that the predicted range clears both the premium and the implied move,
    // so cases about other conditions are not silently also testing the economics gates.
    trailingRange: 1_400,
    expansionBand: 0.25,
    now: NOW,
    ...overrides,
  };
}

describe("proposeVolatilityStraddle", () => {
  it("prices both legs at the same at-the-money strike", () => {
    const proposal = proposeVolatilityStraddle(input());

    expect(proposal.actionable).toBe(true);
    if (!proposal.actionable) return;
    const [call, put] = proposal.legs;
    expect(call.optionType).toBe("CE");
    expect(put.optionType).toBe("PE");
    // A straddle, not a strangle.
    expect(call.strike).toBe(put.strike);
    expect(call.strike).toBe(24_000);
    expect(proposal.quantity).toBe(75);
  });

  it("states the breakeven band and the move it requires", () => {
    const proposal = proposeVolatilityStraddle(input());

    expect(proposal.actionable).toBe(true);
    if (!proposal.actionable) return;
    const { economics, legs } = proposal;
    const combined = legs[0].premium + legs[1].premium;
    expect(economics.totalPremium).toBeCloseTo(combined, 8);
    // At expiry the position pays only outside strike +/- combined premium.
    expect(economics.breakevenUpper).toBeCloseTo(24_000 + combined, 8);
    expect(economics.breakevenLower).toBeCloseTo(24_000 - combined, 8);
    expect(economics.requiredMove).toBeCloseTo(combined, 8);
    expect(economics.deployedCapital).toBeCloseTo(combined * 75, 8);
  });

  it("scales deployed capital by lots without changing the breakeven", () => {
    const one = proposeVolatilityStraddle(input({ lots: 1 }));
    const three = proposeVolatilityStraddle(input({ lots: 3 }));

    expect(one.actionable && three.actionable).toBe(true);
    if (!one.actionable || !three.actionable) return;
    expect(three.quantity).toBe(225);
    expect(three.economics.deployedCapital).toBeCloseTo(one.economics.deployedCapital * 3, 6);
    // Breakeven is a price level, not a function of size.
    expect(three.economics.breakevenUpper).toBeCloseTo(one.economics.breakevenUpper, 8);
  });

  // A range R around an ATM strike gives about R/2 of displacement either way; treating
  // the whole range as favourable assumes a one-directional move with no retrace.
  it("reports the conservative excursion as half the predicted range", () => {
    const proposal = proposeVolatilityStraddle(input({ trailingRange: 1_400, expansionBand: 0.25 }));

    expect(proposal.actionable).toBe(true);
    if (!proposal.actionable) return;
    const { economics } = proposal;
    expect(economics.predictedForwardRange).toBeCloseTo(1_750, 8);
    expect(economics.optimisticExcursion).toBeCloseTo(1_750, 8);
    expect(economics.conservativeExcursion).toBeCloseTo(875, 8);
    expect(economics.conservativeCoverage).toBeCloseTo(875 / economics.requiredMove, 8);
  });

  describe("refusals", () => {
    // CONTRACTION is the profitable side of a *short* straddle, which
    // 023-option-contract-requires-long makes impossible on purpose.
    it("refuses CONTRACTION rather than inverting the structure", () => {
      const proposal = proposeVolatilityStraddle(input({ prediction: "CONTRACTION" }));

      expect(proposal).toMatchObject({ actionable: false, reason: "CONTRACTION_NEEDS_SHORT_PREMIUM" });
    });

    it("refuses the abstain class", () => {
      const proposal = proposeVolatilityStraddle(input({ prediction: "STABLE" }));

      expect(proposal).toMatchObject({ actionable: false, reason: "NOT_AN_EXPANSION_SIGNAL" });
    });

    // Same rule resolveWeeklyExpiryWeekday enforces: a plausible expiry is
    // indistinguishable from a correct one, and prices a contract that never traded.
    it.each([["ASSUMED" as const], [null]])("refuses a %s expiry weekday", (expirySource) => {
      const proposal = proposeVolatilityStraddle(input({ expirySource }));

      expect(proposal).toMatchObject({ actionable: false, reason: "EXPIRY_WEEKDAY_UNCONFIRMED" });
    });

    it.each([[null], [0], [-0.14]])("refuses implied volatility of %s", (impliedVolatility) => {
      const proposal = proposeVolatilityStraddle(input({ impliedVolatility }));

      expect(proposal).toMatchObject({ actionable: false, reason: "NO_IMPLIED_VOLATILITY" });
    });

    it("refuses an unmeasurable trailing range", () => {
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 0 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "TRAILING_RANGE_UNMEASURABLE" });
    });

    it("refuses an expiry that is not in the future", () => {
      const proposal = proposeVolatilityStraddle(input({ expiryDate: new Date("2026-06-01T00:00:00Z") }));

      expect(proposal).toMatchObject({ actionable: false, reason: "EXPIRY_NOT_IN_FUTURE" });
    });

    // The case that matters most: the signal is *correct* and the trade still loses,
    // because a 25% wider range off a quiet base does not reach a breakeven priced off
    // an elevated IV.
    it("refuses when the premium exceeds even the full predicted range", () => {
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 40, impliedVolatility: 0.30 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "PREMIUM_EXCEEDS_PREDICTED_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.explanation).toMatch(/loses money when the signal is correct/);
    });

    // An ATM straddle's premium is the market's own forecast of the move. Predicting a
    // range the chain already prices is not an edge, however accurate it is.
    it("refuses when the market already prices a larger move than predicted", () => {
      // Trailing range clears the premium gate but sits under the implied move.
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 700, impliedVolatility: 0.28 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.explanation).toMatch(/realised volatility beats implied volatility/);
    });

    it("keeps the implied-move comparison honest as IV rises", () => {
      // Identical signal, rising IV: actionable until the chain prices the move.
      // At 10% the chain prices a 361-point move against a predicted 1,750 range; at 50%
      // it prices 1,804 and the predicted range no longer clears it.
      const cheap = proposeVolatilityStraddle(input({ trailingRange: 1_400, impliedVolatility: 0.10 }));
      const dear = proposeVolatilityStraddle(input({ trailingRange: 1_400, impliedVolatility: 0.50 }));

      expect(cheap.actionable).toBe(true);
      expect(dear.actionable).toBe(false);
    });
  });

  it("uses the supplied strike step rather than inferring one from price", () => {
    // NIFTY and BANKNIFTY both trade above 20,000, so a price threshold cannot separate
    // them; a wrong step produces strikes the exchange does not list.
    const banknifty = proposeVolatilityStraddle(input({
      underlyingSymbol: "BANKNIFTY",
      underlyingSpot: 57_240,
      strikeStep: 100,
      lotSize: 15,
      trailingRange: 3_000,
    }));

    expect(banknifty.actionable).toBe(true);
    if (!banknifty.actionable) return;
    expect(banknifty.legs[0].strike % 100).toBe(0);
    expect(banknifty.legs[0].strike).toBe(57_200);
  });
});
