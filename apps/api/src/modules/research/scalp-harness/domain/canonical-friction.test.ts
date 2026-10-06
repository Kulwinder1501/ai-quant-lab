import { describe, expect, it } from "vitest";
import {
  canonicalFrictionModel,
  canonicalFrictionPolicyVersion,
  canonicalFrictionRungsBps,
  frictionR,
  impliedRiskPerUnit,
  netBps,
  netR,
  riskBasisDerivationVersion,
} from "./canonical-friction.js";
import { canonicalOutcomeR, settleResearchPath } from "./settlement.js";
import type { ResearchGeometry, ResearchPriceCandle } from "./contracts.js";

// NIFTY50 at roughly the observed level, with the observed mean stop distance.
const nifty = { entryFillPrice: 24_243, plannedRiskPerUnit: 7.56 };

describe("canonical friction", () => {
  it("charges the round trip twice", () => {
    // 2 x (1/10000) x 24243 = 4.8486 points, over a 7.56-point stop.
    expect(frictionR(nifty, 1)).toBeCloseTo(4.8486 / 7.56, 6);
    // Doubling the rung doubles the cost; there is no fixed component.
    expect(frictionR(nifty, 2)!).toBeCloseTo(2 * frictionR(nifty, 1)!, 9);
  });

  it("makes friction larger in R terms as the stop tightens", () => {
    // The mechanism that penalises faster architectures: identical bps, tighter stop, more of a risk
    // unit consumed. This is why a scalp bracket is punished harder than a swing bracket.
    const tight = frictionR({ ...nifty, plannedRiskPerUnit: 4 }, 2)!;
    const wide = frictionR({ ...nifty, plannedRiskPerUnit: 20 }, 2)!;
    expect(tight).toBeGreaterThan(wide);
  });

  it("subtracts friction from gross R", () => {
    expect(netR(1.5, nifty, 1)).toBeCloseTo(1.5 - frictionR(nifty, 1)!, 9);
  });

  it("keeps an ungradeable outcome ungradeable", () => {
    // Subtracting a cost from "we could not grade this" must not manufacture a number.
    expect(netR(null, nifty, 2)).toBeNull();
  });

  it("refuses geometry that cannot support the conversion instead of throwing", () => {
    // A settled row with no fill price is a data condition the caller excludes, not a crash.
    expect(frictionR({ entryFillPrice: 0, plannedRiskPerUnit: 7.56 }, 1)).toBeNull();
    expect(frictionR({ entryFillPrice: 24_243, plannedRiskPerUnit: 0 }, 1)).toBeNull();
    expect(frictionR({ entryFillPrice: Number.NaN, plannedRiskPerUnit: 7.56 }, 1)).toBeNull();
    expect(netR(1.5, { entryFillPrice: 24_243, plannedRiskPerUnit: 0 }, 1)).toBeNull();
  });

  it("charges bps exactly twice, with no geometry involved", () => {
    expect(netBps(10, 2)).toBe(6);
    expect(netBps(-0.32, 1)).toBeCloseTo(-2.32, 6);
    expect(netBps(null, 1)).toBeNull();
  });

  it("exposes a rung ladder rather than a single asserted cost", () => {
    // A single number would be a free parameter worth more to apparent viability than almost any
    // other choice; the ladder is what carries the uncertainty.
    expect([...canonicalFrictionRungsBps]).toEqual([1, 2, 5]);
  });

  it("carries a label that denies being option economics", () => {
    // The failure mode is silent: a net figure quoted without this reads as native trading cost.
    expect(canonicalFrictionModel).toContain("NOT option execution economics");
    expect(canonicalFrictionPolicyVersion).toBe("SCALP_CANONICAL_FRICTION_V1");
  });
});

describe("implied risk per unit", () => {
  const decisionAt = new Date("2026-08-21T04:30:00.000Z");
  const sessionCloseAt = new Date(decisionAt.getTime() + 120 * 60_000);

  function settleOnce(
    geometry: Pick<ResearchGeometry, "entryPrice" | "stopLoss" | "targetPrice" | "direction">,
    bar: Pick<ResearchPriceCandle, "open" | "high" | "low" | "close">,
  ) {
    return settleResearchPath({
      subjectType: "CANONICAL_OPPORTUNITY",
      subjectId: "subject",
      geometry: {
        ...geometry,
        entryOrderType: "MARKET_AT_REFERENCE",
        expiresAt: new Date(decisionAt.getTime() + 60 * 60_000),
        geometryPolicyVersion: "TEST_GEOMETRY_V1",
      },
      decisionAt,
      sessionCloseAt,
      forwardCandles: [{
        openTime: decisionAt,
        closeTime: new Date(decisionAt.getTime() + 60_000),
        ...bar,
      }],
    }).terminal!;
  }

  /*
   * The load-bearing test.
   *
   * The derivation is only worth anything if it returns the same stop distance the settlement actually
   * divided by. Recovering it from a real settled row -- rather than from hand-built numbers that assume
   * the algebra -- is what would catch an inverted quotient or a factor of 10000 in the wrong place.
   */
  it("recovers the stop distance a real settlement was graded against", () => {
    const long = { direction: "LONG" as const, entryPrice: 24_243, stopLoss: 24_235.44, targetPrice: 24_254.34 };
    const terminal = settleOnce(long, { open: 24_243, high: 24_260, low: 24_240, close: 24_255 });

    expect(terminal.outcome).toBe("TARGET");
    expect(impliedRiskPerUnit(terminal)).toBeCloseTo(long.entryPrice - long.stopLoss, 6);
  });

  it("recovers it on a short, where the signs of both stored figures flip together", () => {
    // Both returnBps and rMultiple carry the sign of the same move, so the quotient stays positive.
    // A sign error in either would surface here as a negative risk distance and a null.
    const short = { direction: "SHORT" as const, entryPrice: 57_500, stopLoss: 57_564, targetPrice: 57_404 };
    const terminal = settleOnce(short, { open: 57_500, high: 57_520, low: 57_400, close: 57_410 });

    expect(terminal.outcome).toBe("TARGET");
    /*
     * Relative, not absolute — and the distinction is a real property rather than a loose assertion.
     *
     * The algebra is exact, but `returnBps` and `rMultiple` are each stored to six decimals, so the
     * quotient inherits roughly 1e-8 of relative error. On a BANKNIFTY-sized 64-point stop that is
     * about 1e-6 in absolute points, which an absolute six-decimal tolerance would reject. It is far
     * below anything that matters for a cost figure: at the 1 bps rung it moves friction in R by
     * around 1e-8 R. Asserting it relatively is what keeps this test sensitive to a genuine algebra
     * error on any instrument, instead of only on the ones whose stops happen to be small.
     */
    const recovered = impliedRiskPerUnit(terminal)!;
    const expected = short.stopLoss - short.entryPrice;
    expect(Math.abs(recovered - expected) / expected).toBeLessThan(1e-7);
  });

  it("recovers it from a loss as well as a win", () => {
    const long = { direction: "LONG" as const, entryPrice: 100, stopLoss: 99, targetPrice: 101.5 };
    const terminal = settleOnce(long, { open: 100, high: 100.2, low: 98.9, close: 99 });

    expect(terminal.outcome).toBe("STOP");
    expect(terminal.rMultiple).toBeLessThan(0);
    expect(impliedRiskPerUnit(terminal)).toBeCloseTo(1, 6);
  });

  it("returns null for a settlement that resolved exactly at its entry price", () => {
    // A timeout landing on the entry is a real outcome with no recoverable risk distance: 0/0. Null is
    // the honest answer, and the caller reports it as uncovered rather than substituting a guess.
    expect(impliedRiskPerUnit({ entryFillPrice: 100, returnBps: 0, rMultiple: 0 })).toBeNull();
  });

  it("refuses null, non-finite and inconsistent inputs", () => {
    expect(impliedRiskPerUnit({ entryFillPrice: null, returnBps: 10, rMultiple: 1 })).toBeNull();
    expect(impliedRiskPerUnit({ entryFillPrice: 100, returnBps: null, rMultiple: 1 })).toBeNull();
    expect(impliedRiskPerUnit({ entryFillPrice: 100, returnBps: 10, rMultiple: null })).toBeNull();
    expect(impliedRiskPerUnit({ entryFillPrice: 0, returnBps: 10, rMultiple: 1 })).toBeNull();
    expect(impliedRiskPerUnit({ entryFillPrice: 100, returnBps: Number.NaN, rMultiple: 1 })).toBeNull();
    // Opposite signs cannot come from one settlement; treated as inconsistency rather than a distance.
    expect(impliedRiskPerUnit({ entryFillPrice: 100, returnBps: -10, rMultiple: 1 })).toBeNull();
  });

  /*
   * The semantic assumptions, pinned separately from the numerical recovery.
   *
   * `impliedRiskPerUnit` is arithmetic over two stored figures, so it keeps returning a plausible
   * number if either figure is redefined -- a cost-adjusted `rMultiple` being the obvious candidate.
   * Nothing about the quotient would fail; it would simply stop being a risk distance. These assertions
   * are what turn that into a test failure instead of a silently wrong cost report.
   */
  it("pins rMultiple as gross signed move over planned risk", () => {
    const long = { direction: "LONG" as const, entryPrice: 100, stopLoss: 99, targetPrice: 101.5 };
    const terminal = settleOnce(long, { open: 100, high: 102, low: 99.5, close: 101.5 });

    // Target hit: move is 1.5 points over a 1-point planned risk. Exactly 1.5, with no cost deducted.
    expect(terminal.rMultiple).toBe(1.5);
    expect(canonicalOutcomeR(terminal)).toBe(terminal.rMultiple);
  });

  it("pins returnBps as gross signed move over entry fill, in basis points", () => {
    const long = { direction: "LONG" as const, entryPrice: 100, stopLoss: 99, targetPrice: 101.5 };
    const terminal = settleOnce(long, { open: 100, high: 102, low: 99.5, close: 101.5 });

    // 1.5 / 100 x 10000 = 150 bps.
    expect(terminal.returnBps).toBe(150);
  });

  it("keeps the two stored definitions consistent with each other", () => {
    // returnBps / rMultiple must equal plannedRisk / entryFillPrice x 10000 for the derivation to be a
    // risk distance at all. If one figure ever becomes net of cost and the other stays gross, this
    // ratio breaks and the recovery is meaningless.
    const long = { direction: "LONG" as const, entryPrice: 24_243, stopLoss: 24_235.44, targetPrice: 24_254.34 };
    const terminal = settleOnce(long, { open: 24_243, high: 24_260, low: 24_240, close: 24_255 });
    const plannedRisk = long.entryPrice - long.stopLoss;

    const storedRatio = terminal.returnBps! / terminal.rMultiple!;
    const definitionalRatio = (plannedRisk / terminal.entryFillPrice!) * 10_000;
    expect(Math.abs(storedRatio - definitionalRatio) / definitionalRatio).toBeLessThan(1e-7);
  });

  it("carries an explicit derivation version", () => {
    expect(riskBasisDerivationVersion).toBe("RISK_BASIS_DERIVATION_V1");
  });

  it("composes with the friction ladder to give net R on a stored row", () => {
    const long = { direction: "LONG" as const, entryPrice: 24_243, stopLoss: 24_235.44, targetPrice: 24_254.34 };
    const terminal = settleOnce(long, { open: 24_243, high: 24_260, low: 24_240, close: 24_255 });
    const plannedRiskPerUnit = impliedRiskPerUnit(terminal)!;
    const geometry = { entryFillPrice: terminal.entryFillPrice!, plannedRiskPerUnit };

    // The point of reporting R rather than only bps: at this stop distance one basis point costs most
    // of a risk unit, which a constant "minus 2 bps" cannot show.
    expect(frictionR(geometry, 1)!).toBeGreaterThan(0.6);
    expect(netR(terminal.rMultiple, geometry, 1)!)
      .toBeCloseTo(terminal.rMultiple! - frictionR(geometry, 1)!, 9);
  });
});
