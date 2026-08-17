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
    isListedExpiry: true,
    strikeStep: 50,
    lotSize: 75,
    lots: 1,
    // Wide enough that the predicted range clears both the premium and the implied move,
    // so cases about other conditions are not silently also testing the economics gates.
    trailingRange: 1_400,
    expansionBand: 0.25,
    // 5 bars of 15m = 75 minutes, the shape of the models that actually feed this.
    predictionHorizonYears: (15 * 5) / (365 * 24 * 60),
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
    // totalPremium is snapped to the 0.05 exchange tick, so it is not the raw leg sum.
    const rounded = Math.round((Math.round(combined / 0.05) * 0.05 + Number.EPSILON) * 100) / 100;
    expect(economics.totalPremium).toBeCloseTo(rounded, 8);
    // At expiry the position pays only outside strike +/- the rounded premium.
    expect(economics.breakevenUpper).toBeCloseTo(24_000 + rounded, 8);
    expect(economics.breakevenLower).toBeCloseTo(24_000 - rounded, 8);
    expect(economics.requiredMove).toBeCloseTo(rounded, 8);
    expect(economics.deployedCapital).toBeCloseTo(rounded * 75, 8);
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

    // A plausible expiry is indistinguishable from a correct one, and prices a
    // contract that never traded.
    it("refuses an unlisted expiry", () => {
      const proposal = proposeVolatilityStraddle(input({ isListedExpiry: false }));

      expect(proposal).toMatchObject({ actionable: false, reason: "EXPIRY_UNLISTED" });
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
    it("refuses when the premium exceeds the expected (half-range) directional move", () => {
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 1300, impliedVolatility: 0.30 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "PREMIUM_EXCEEDS_PREDICTED_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.explanation).toMatch(/loses money when the signal is correct/);
    });

    // An ATM straddle's premium is the market's own forecast of the move. Predicting a
    // range the chain already prices is not an edge, however accurate it is.
    it("refuses when the market already prices a larger move than predicted", () => {
      // Recalibrated when the gate moved to the horizon-scaled implied move. The numbers had to
      // change because the comparison did: at 28% IV the chain prices ~80 points over 75 minutes
      // against ~1,800 over the option's eight-day life, so the old 700-point range no longer
      // fails this gate. A 50-point range does, which is the same condition being tested --
      // predicting less than the market already prices -- expressed on the correct horizon.
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 50, impliedVolatility: 0.28 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.explanation).toMatch(/realised volatility beats implied volatility/);
    });

    it("compares the prediction against implied over its own horizon, not the option's life", () => {
      // The defect this replaced. A 15m/h5 prediction spans 75 minutes; the expiry here is 8 days
      // out. Measured live 2026-08-17: every evaluation refused at a predicted 43.44 against a
      // full-life implied move of 408.18 -- roughly 9x, which is the horizon ratio and not a
      // market judgment, so the straddle could never fire whatever the signal said.
      const horizonYears = (15 * 5) / (365 * 24 * 60);
      const spot = 24_300;
      const iv = 0.1134;
      const overHorizon = spot * iv * Math.sqrt(horizonYears);
      const overOptionLife = spot * iv * Math.sqrt(8 / 365);

      // A range that beats implied over 75 minutes but not over eight days: previously refused.
      const trailingRange = ((overHorizon + overOptionLife) / 2) / 1.25;
      expect(trailingRange * 1.25).toBeGreaterThan(overHorizon);
      expect(trailingRange * 1.25).toBeLessThan(overOptionLife);

      const proposal = proposeVolatilityStraddle(input({
        underlyingSpot: spot,
        impliedVolatility: iv,
        trailingRange,
        predictionHorizonYears: horizonYears,
      }));

      // It must get past this gate now. Whether it survives the premium gates is a separate
      // question and deliberately not asserted here.
      if (!proposal.actionable) {
        expect(proposal.reason).not.toBe("MARKET_ALREADY_PRICES_THE_MOVE");
      }
    });

    it("reports both the horizon-scaled and full-life implied move, so the gate is auditable", () => {
      const proposal = proposeVolatilityStraddle(input());
      if (!proposal.actionable) throw new Error(`expected actionable, got ${proposal.reason}`);
      // The horizon is a fraction of the option's life, so the scaled move must be the smaller.
      expect(proposal.economics.impliedMoveOverHorizon).toBeLessThan(proposal.economics.impliedMove);
      expect(proposal.economics.impliedMoveOverHorizon).toBeGreaterThan(0);
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
    // A wrong step produces strikes the exchange does not list.
    const nifty = proposeVolatilityStraddle(input({
      underlyingSymbol: "NIFTY50",
      underlyingSpot: 24_240,
      strikeStep: 100,
      lotSize: 75,
      trailingRange: 1_000,
    }));

    expect(nifty.actionable).toBe(true);
    if (!nifty.actionable) return;
    expect(nifty.legs[0].strike % 100).toBe(0);
    expect(nifty.legs[0].strike).toBe(24_200);
  });

  it("handles a monthly-tenor index with rounded total premium correctly", () => {
    const monthlyExpiry = new Date("2026-08-25T10:00:00Z"); // Approx 2-4 weeks out
    const nifty = proposeVolatilityStraddle(input({
      underlyingSymbol: "NIFTY50",
      underlyingSpot: 24_000,
      impliedVolatility: 0.15,
      strikeStep: 50,
      lotSize: 75,
      lots: 1,
      // A monthly expiry prices in ~55 days of implied move; the predicted range has
      // to clear that (not just a 5-day-equivalent range) or both economics gates
      // correctly refuse it — this is the same tenor-mismatch this project's own
      // straddle research already measured as dead for a short-horizon signal.
      trailingRange: 2500,
      expiryDate: monthlyExpiry,
      isListedExpiry: true
    }));

    expect(nifty.actionable).toBe(true);
    if (!nifty.actionable) return;
    const { economics } = nifty;
    // Ensure total premium is rounded to a 0.05 tick
    expect(economics.totalPremium % 0.05).toBeCloseTo(0, 5);
    // Breakeven must match strike +/- rounded premium exactly
    const strike = nifty.legs[0].strike;
    expect(economics.breakevenUpper).toBe(strike + economics.totalPremium);
    expect(economics.breakevenLower).toBe(strike - economics.totalPremium);
  });
});
