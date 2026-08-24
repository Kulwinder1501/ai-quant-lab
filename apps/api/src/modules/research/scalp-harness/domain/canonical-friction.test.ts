import { describe, expect, it } from "vitest";
import {
  canonicalFrictionModel,
  canonicalFrictionPolicyVersion,
  canonicalFrictionRungsBps,
  frictionR,
  netBps,
  netR,
} from "./canonical-friction.js";

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
