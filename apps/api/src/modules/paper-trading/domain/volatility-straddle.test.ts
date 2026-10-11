import { describe, expect, it } from "vitest";
import { yearsToExpiry } from "@ai-quant-lab/pricing";
import {
  calendarHorizonYears,
  proposeVolatilityStraddle,
  tradingHorizonYears,
  tradingYearsToMinutes,
  type CalendarYears,
  type ProposeStraddleInput,
  type TradingYears,
} from "./volatility-straddle.js";

// 5 bars of 15m = 75 minutes, the shape of the models that actually feed this.
const TRADING_75M = tradingHorizonYears("15m", 5) as TradingYears;
const CALENDAR_75M = calendarHorizonYears("15m", 5) as CalendarYears;

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
    tradingHorizonYears: TRADING_75M,
    calendarHorizonYears: CALENDAR_75M,
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
      const spot = 24_300;
      const iv = 0.1134;
      const overHorizon = spot * iv * Math.sqrt(TRADING_75M);
      const overOptionLife = spot * iv * Math.sqrt(8 / 365);

      // A range that beats implied over 75 minutes but not over eight days: previously refused.
      const trailingRange = ((overHorizon + overOptionLife) / 2) / 1.25;
      expect(trailingRange * 1.25).toBeGreaterThan(overHorizon);
      expect(trailingRange * 1.25).toBeLessThan(overOptionLife);

      const proposal = proposeVolatilityStraddle(input({
        underlyingSpot: spot,
        impliedVolatility: iv,
        trailingRange,
      }));

      // It must get past this gate now. Whether it survives the premium gates is a separate
      // question and deliberately not asserted here.
      if (!proposal.actionable) {
        expect(proposal.reason).not.toBe("MARKET_ALREADY_PRICES_THE_MOVE");
      }
    });

    it("compares displacement against displacement, not a two-sided range against one", () => {
      // A high-low range counts movement both ways; sigma*sqrt(t) is one-sided. A range just over
      // the implied move used to pass, crediting the signal with twice the displacement it claims.
      const spot = 24_000;
      const iv = 0.14;
      const impliedOverHorizon = spot * iv * Math.sqrt(TRADING_75M);
      // Range beats implied; half-range does not. This is the window the old comparison let through.
      const trailingRange = (impliedOverHorizon * 1.5) / 1.25;

      const proposal = proposeVolatilityStraddle(input({ trailingRange }));

      expect(proposal).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.economics?.predictedForwardRange).toBeGreaterThan(impliedOverHorizon);
      expect(proposal.economics?.conservativeExcursion).toBeLessThan(impliedOverHorizon);
    });

    it("carries the economics on an economics refusal, so the verdict is numbers and not prose", () => {
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 1300, impliedVolatility: 0.30 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "PREMIUM_EXCEEDS_PREDICTED_MOVE" });
      if (proposal.actionable) return;
      expect(proposal.economics).toBeDefined();
      expect(proposal.economics!.totalPremium).toBeGreaterThan(proposal.economics!.conservativeExcursion);
    });

    it("omits economics when the refusal is a missing input rather than a verdict about money", () => {
      const proposal = proposeVolatilityStraddle(input({ impliedVolatility: null }));

      expect(proposal).toMatchObject({ actionable: false, reason: "NO_IMPLIED_VOLATILITY" });
      if (proposal.actionable) return;
      // "Unpriceable" and "priced and rejected" must not read the same.
      expect(proposal.economics).toBeUndefined();
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

  describe("horizon economics", () => {
    it("charges the horizon's decay rather than the whole tenor's", () => {
      const proposal = proposeVolatilityStraddle(input());
      if (!proposal.actionable) throw new Error(`expected actionable, got ${proposal.reason}`);
      const { economics } = proposal;

      // 75 minutes is about 0.65% of an eight-day life, and an at-the-money premium scales with
      // its square root, so the wait costs roughly 0.33% of the premium. The hold-to-expiry view
      // charges the entire premium instead, and that gap is the tenor mismatch in one number.
      expect(economics.decayCostOverHorizon).toBeGreaterThan(0);
      expect(economics.decayCostOverHorizon).toBeLessThan(economics.totalPremium * 0.01);
      expect(economics.timeToExpiryAtHorizonYears).toBeLessThan(proposal.timeToExpiryYears);
      expect(economics.timeToExpiryAtHorizonYears).toBeGreaterThan(0);
    });

    // The whole point of the fix, as one assertion: a signal the expiry payoff calls a loser is a
    // winner when the position is released at the horizon. The refusal is about the contract's
    // length, not about the signal being weak.
    it("shows a positive horizon net on a signal the expiry payoff refuses", () => {
      // Half-range 200 clears the 40-point implied move over 75 minutes, and falls well short of
      // the ~398 premium an eight-day contract charges.
      const proposal = proposeVolatilityStraddle(input({ trailingRange: 320 }));

      expect(proposal).toMatchObject({ actionable: false, reason: "PREMIUM_EXCEEDS_PREDICTED_MOVE" });
      if (proposal.actionable) return;
      const economics = proposal.economics!;
      expect(economics.conservativeExcursion).toBeLessThan(economics.requiredMove);
      expect(economics.horizonNetPerUnit).toBeGreaterThan(0);
      expect(proposal.explanation).toMatch(/tenor penalty/);
    });

    // Two derivations of one condition. The closed-form gate compares the half-range against
    // sigma*sqrt(dt) in TRADING time; the economics reprice both legs one CALENDAR dt later. When
    // trading and calendar time coincide (a daily-style 1:1 clock, built here by hand) gamma gain
    // and decay cross exactly where the two are equal, so the repriced net follows the gate. If
    // these ever disagree on one clock, one of them is wrong.
    it("agrees with the closed-form implied-move gate on a common clock", () => {
      const spot = 24_000;
      const iv = 0.14;
      const years = (15 * 5) / (365 * 24 * 60);
      const impliedOverHorizon = spot * iv * Math.sqrt(years);
      const atExcursionMultiple = (multiple: number) => {
        const proposal = proposeVolatilityStraddle(input({
          underlyingSpot: spot,
          impliedVolatility: iv,
          // One clock for both, to isolate the agreement from the intended clock difference.
          tradingHorizonYears: years as TradingYears,
          calendarHorizonYears: years as CalendarYears,
          // conservativeExcursion is half the range, so a multiple of the implied move needs twice that.
          trailingRange: (impliedOverHorizon * multiple * 2) / 1.25,
        }));
        const economics = proposal.actionable ? proposal.economics : proposal.economics;
        if (!economics) throw new Error("economics missing from an economics verdict");
        return {
          net: economics.horizonNetPerUnit,
          refusedByGate: !proposal.actionable && proposal.reason === "MARKET_ALREADY_PRICES_THE_MOVE",
        };
      };

      // Either side of the crossover, and close to it: the gate and the repriced net turn over
      // together. The 10% margin is the second-order approximation's error, not slack in the claim.
      const under = atExcursionMultiple(0.9);
      const over = atExcursionMultiple(1.1);
      expect(under.net).toBeLessThan(0);
      expect(under.refusedByGate).toBe(true);
      expect(over.net).toBeGreaterThan(0);
      expect(over.refusedByGate).toBe(false);
      // Far from it, the same ordering holds and the magnitudes grow with the square of the move.
      expect(atExcursionMultiple(0.5).net).toBeLessThan(under.net);
      expect(atExcursionMultiple(4).net).toBeGreaterThan(over.net);
    });

    it("on the real clocks the trading-time gate is the stricter test: a signal it passes nets positive", () => {
      const spot = 24_000;
      const iv = 0.14;
      const impliedTrading = spot * iv * Math.sqrt(TRADING_75M);
      const run = (multiple: number) => proposeVolatilityStraddle(input({
        underlyingSpot: spot,
        impliedVolatility: iv,
        trailingRange: (impliedTrading * multiple * 2) / 1.25,
      }));

      const passes = run(1.1);
      const economicsOfPass = passes.actionable ? passes.economics : passes.economics!;
      expect(!passes.actionable && passes.reason === "MARKET_ALREADY_PRICES_THE_MOVE").toBe(false);
      expect(economicsOfPass.horizonNetPerUnit).toBeGreaterThan(0);
      // Between the calendar-time and the trading-time implied move: the old gate passed this,
      // the corrected one refuses it, because the market prices that much movement in 75 minutes.
      const calendarImplied = spot * iv * Math.sqrt(CALENDAR_75M);
      expect(calendarImplied).toBeLessThan(impliedTrading);
      const between = run(((calendarImplied + impliedTrading) / 2) / impliedTrading);
      expect(between).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
    });

    it("values a horizon that overruns the expiry at the expiry payoff", () => {
      // A 20-day horizon on an 8-day contract: there is no mark-to-market left to take, and the
      // straddle is worth its intrinsic value. Repricing at a negative remaining life would be
      // meaningless, so the excursion itself is the answer.
      const proposal = proposeVolatilityStraddle(input({
        tradingHorizonYears: (20 / 365) as TradingYears,
        calendarHorizonYears: (20 / 365) as CalendarYears,
      }));
      if (!proposal.actionable) throw new Error(`expected actionable, got ${proposal.reason}`);
      const { economics } = proposal;

      expect(economics.timeToExpiryAtHorizonYears).toBeLessThan(0);
      expect(economics.horizonExitValue).toBeCloseTo(economics.conservativeExcursion, 2);
      expect(economics.decayCostOverHorizon).toBeCloseTo(economics.totalPremium, 2);
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

describe("two clocks: trading time for the implied move, calendar time for theta", () => {
  it("builds the horizons on their own clocks, including the daily bar", () => {
    // 75 minutes: 75 / (375 * 252) trading years, 75 / 525,600 calendar years.
    expect(tradingHorizonYears("15m", 5)).toBeCloseTo(75 / 94_500, 12);
    expect(calendarHorizonYears("15m", 5)).toBeCloseTo(75 / 525_600, 12);
    // A daily bar is 1/252 of a trading year, and a calendar day of contract life.
    expect(tradingHorizonYears("1d", 1)).toBeCloseTo(1 / 252, 12);
    expect(calendarHorizonYears("1d", 1)).toBeCloseTo(1 / 365, 12);
    expect(tradingHorizonYears("1w", 1)).toBeNull();
    expect(calendarHorizonYears("15m", 0)).toBeNull();
    // The two clocks differ by sqrt(525,600 / 94,500) = 2.36x in implied-move terms.
    expect(Math.sqrt((tradingHorizonYears("15m", 5) as number) / (calendarHorizonYears("15m", 5) as number)))
      .toBeCloseTo(Math.sqrt(525_600 / 94_500), 9);
    expect(tradingYearsToMinutes(TRADING_75M)).toBeCloseTo(75, 9);
  });

  it("prices the NIFTY 23,400 / 13% IV / 75-minute implied move at 85.7 points, not 36.5", () => {
    // Refuse on purpose with a tiny range so the economics are reported on the refusal.
    const proposal = proposeVolatilityStraddle(input({
      underlyingSpot: 23_400, impliedVolatility: 0.13, trailingRange: 10,
    }));
    expect(proposal).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
    if (proposal.actionable) return;
    expect(proposal.economics!.impliedMoveOverHorizon).toBeCloseTo(85.7, 1);
    // What the calendar-minute scaling used to say.
    expect(23_400 * 0.13 * Math.sqrt(75 / 525_600)).toBeCloseTo(36.3, 0);
    expect(proposal.explanation).toMatch(/75 trading minutes/);
  });

  it("refuses a half-range between the old calendar-time move and the trading-time move", () => {
    // Half-range 60: above 36.5 (old gate would pass) and below 85.7 (the corrected gate refuses).
    const proposal = proposeVolatilityStraddle(input({
      underlyingSpot: 23_400, impliedVolatility: 0.13, trailingRange: 120 / 1.25,
    }));
    expect(proposal).toMatchObject({ actionable: false, reason: "MARKET_ALREADY_PRICES_THE_MOVE" });
  });

  it("leaves theta, time-to-expiry-at-horizon and the tenor penalty on the calendar clock", () => {
    const base = proposeVolatilityStraddle(input({ trailingRange: 1_400 }));
    // Changing ONLY the trading clock must not move any theta-driven quantity...
    const otherTrading = proposeVolatilityStraddle(input({
      trailingRange: 1_400, tradingHorizonYears: (TRADING_75M * 2) as TradingYears,
    }));
    if (!base.actionable || !otherTrading.actionable) throw new Error("expected actionable");
    expect(otherTrading.economics.timeToExpiryAtHorizonYears).toBe(base.economics.timeToExpiryAtHorizonYears);
    expect(otherTrading.economics.decayCostOverHorizon).toBe(base.economics.decayCostOverHorizon);
    expect(otherTrading.economics.horizonExitValue).toBe(base.economics.horizonExitValue);
    // ...while it does scale the implied move by sqrt(2).
    expect(otherTrading.economics.impliedMoveOverHorizon)
      .toBeCloseTo(base.economics.impliedMoveOverHorizon * Math.SQRT2, 8);

    // And changing ONLY the calendar clock moves time-to-expiry at the horizon, not the implied move.
    const otherCalendar = proposeVolatilityStraddle(input({
      trailingRange: 1_400, calendarHorizonYears: (CALENDAR_75M * 4) as CalendarYears,
    }));
    if (!otherCalendar.actionable) throw new Error("expected actionable");
    expect(otherCalendar.economics.impliedMoveOverHorizon).toBe(base.economics.impliedMoveOverHorizon);
    expect(base.economics.timeToExpiryAtHorizonYears - otherCalendar.economics.timeToExpiryAtHorizonYears)
      .toBeCloseTo(CALENDAR_75M * 3, 12);
    expect(otherCalendar.economics.decayCostOverHorizon).toBeGreaterThan(base.economics.decayCostOverHorizon);
  });

  it("states the tenor penalty from the calendar span and prints trading minutes", () => {
    const proposal = proposeVolatilityStraddle(input({ trailingRange: 320 }));
    expect(proposal).toMatchObject({ actionable: false, reason: "PREMIUM_EXCEEDS_PREDICTED_MOVE" });
    if (proposal.actionable) return;
    const expectedPenalty = Math.sqrt(yearsToExpiry(NOW, EXPIRY) / CALENDAR_75M).toFixed(1);
    expect(proposal.explanation).toContain("75-trading-minute prediction");
    expect(proposal.explanation).toContain(`${expectedPenalty}x tenor penalty`);
  });
});