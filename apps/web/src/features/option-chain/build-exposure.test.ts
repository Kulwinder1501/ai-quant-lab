import { describe, expect, it } from "vitest";
import {
  buildExposure,
  deltaUnitsAxisFormatter,
  formatDeltaUnits,
  formatFlipOffset,
  formatRupees,
  NET_NOISE_SHARE,
  legExposure,
  netGexAtSpot,
  niceCeil,
  rupeeAxisFormatter,
  SWEEP_RANGE_PERCENT,
  symmetricTicks,
  type ExposureLegInput,
  type ExposureStrikeInput,
} from "./build-exposure";

/** Synthetic chain inputs, hand-built for the arithmetic below (not recorded from the API). */
const SPOT = 22_600;
const FORWARD = 22_595;
const RATE = 0.065; // the pricing package's RISK_FREE_RATE

const leg = (overrides: Partial<ExposureLegInput> = {}): ExposureLegInput => ({
  openInterest: 100_000,
  impliedVolatility: 0.15,
  daysToExpiry: 7,
  ...overrides,
});

/** Black-Scholes gamma, written out here so the module is checked against the formula and not against its own dependency. */
function bsGamma(pricingSpot: number, strike: number, sigma: number, years: number): number {
  const d1 = (Math.log(pricingSpot / strike) + (RATE + 0.5 * sigma * sigma) * years) / (sigma * Math.sqrt(years));
  return Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI) / (pricingSpot * sigma * Math.sqrt(years));
}

describe("legExposure", () => {
  it("is gamma x OI, and gex is that x spot^2 x 0.01, checked against the Black-Scholes formula", () => {
    const years = 7 / 365;
    const pricingSpot = FORWARD * Math.exp(-RATE * years);
    const expectedGamma = bsGamma(pricingSpot, 22_600, 0.15, years);

    const result = legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg(), spot: SPOT, forward: FORWARD });
    expect("excluded" in result).toBe(false);
    if ("excluded" in result) return;
    expect(result.gamma).toBeCloseTo(expectedGamma, 9);
    expect(result.gammaOi).toBeCloseTo(expectedGamma * 100_000, 4);
    expect(result.gex).toBeCloseTo(expectedGamma * 100_000 * SPOT * SPOT * 0.01, 0);
  });

  it("gives a call and a put at the same strike the same gamma", () => {
    const call = legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg(), spot: SPOT, forward: FORWARD });
    const put = legExposure({ strikePrice: 22_600, optionType: "PE", leg: leg(), spot: SPOT, forward: FORWARD });
    if ("excluded" in call || "excluded" in put) throw new Error("unexpected exclusion");
    expect(call.gamma).toBeCloseTo(put.gamma, 12);
  });

  it("charges a long at-the-money option a positive daily decay, equal to minus its theta times the OI", () => {
    const result = legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg({ openInterest: 50_000 }), spot: SPOT, forward: FORWARD });
    if ("excluded" in result) throw new Error("unexpected exclusion");
    expect(result.theta).toBeLessThan(0);
    expect(result.decay).toBeCloseTo(-result.theta * 50_000, 6);
    expect(result.decay).toBeGreaterThan(0);
  });

  it("treats zero open interest as a real zero, not as missing", () => {
    const result = legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg({ openInterest: 0 }), spot: SPOT, forward: FORWARD });
    if ("excluded" in result) throw new Error("unexpected exclusion");
    expect(result.gammaOi).toBeCloseTo(0, 12);
    expect(result.gex).toBeCloseTo(0, 12);
    expect(result.decay).toBeCloseTo(0, 12);
    expect(result.gamma).toBeGreaterThan(0); // the per-contract gamma is still there: only the OI is zero
  });

  it("leaves a leg out, with the reason, when OI, IV or time to expiry is missing, and never counts it as zero", () => {
    const run = (overrides: Partial<ExposureLegInput>) =>
      legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg(overrides), spot: SPOT, forward: FORWARD });
    expect(run({ openInterest: null })).toEqual({ excluded: "noOpenInterest" });
    expect(run({ openInterest: -5 })).toEqual({ excluded: "noOpenInterest" });
    expect(run({ impliedVolatility: null })).toEqual({ excluded: "noImpliedVolatility" });
    expect(run({ impliedVolatility: 0 })).toEqual({ excluded: "noImpliedVolatility" });
    expect(run({ daysToExpiry: null })).toEqual({ excluded: "noExpiry" });
    expect(run({ daysToExpiry: 0 })).toEqual({ excluded: "noExpiry" });
  });

  it("puts more gamma where the option is at the money than far out of the money", () => {
    const at = legExposure({ strikePrice: 22_600, optionType: "CE", leg: leg(), spot: SPOT, forward: FORWARD });
    const far = legExposure({ strikePrice: 23_800, optionType: "CE", leg: leg(), spot: SPOT, forward: FORWARD });
    if ("excluded" in at || "excluded" in far) throw new Error("unexpected exclusion");
    expect(at.gamma).toBeGreaterThan(far.gamma * 10);
  });
});

function chain(rows: Array<{ strike: number; call?: Partial<ExposureLegInput> | null; put?: Partial<ExposureLegInput> | null }>): ExposureStrikeInput[] {
  return rows.map((row) => ({
    strikePrice: row.strike,
    call: row.call === null ? null : leg(row.call ?? {}),
    put: row.put === null ? null : leg(row.put ?? {}),
  }));
}

describe("buildExposure: per-strike points and totals", () => {
  const strikes = chain([
    { strike: 22_400 }, { strike: 22_500 }, { strike: 22_600 }, { strike: 22_700 }, { strike: 22_800 },
  ]);

  it("sums the totals over every strike given, in rupees and in delta-units", () => {
    const result = buildExposure(strikes, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.totals.strikesInChain).toBe(5);
    expect(result.totals.lowestStrike).toBe(22_400);
    expect(result.totals.highestStrike).toBe(22_800);
    const callSum = result.points.reduce((sum, p) => sum + (p.callGex ?? 0), 0);
    expect(result.totals.callGex).toBeCloseTo(callSum, 4);
    expect(result.totals.callGammaOi).toBeGreaterThan(0);
    expect(result.totals.putDecay).toBeGreaterThan(0);
  });

  it("shows only the window around ATM as points but totals over all strikes", () => {
    const result = buildExposure(strikes, { spot: SPOT, forward: FORWARD, atmStrike: 22_600, window: 1 });
    expect(result.points.map((p) => p.strike)).toEqual([22_500, 22_600, 22_700]);
    expect(result.totals.strikesInChain).toBe(5);
    const windowSum = result.points.reduce((sum, p) => sum + (p.callGex ?? 0), 0);
    expect(result.totals.callGex).toBeGreaterThan(windowSum);
  });

  it("returns the strikes in price order whatever order they arrive in", () => {
    const result = buildExposure([...strikes].reverse(), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.points.map((p) => p.strike)).toEqual([22_400, 22_500, 22_600, 22_700, 22_800]);
  });

  it("centres on the middle strike when the ATM strike is not in the chain", () => {
    const result = buildExposure(strikes, { spot: SPOT, forward: FORWARD, atmStrike: 99_999, window: 0 });
    expect(result.points.map((p) => p.strike)).toEqual([22_600]);
  });

  it("is net call minus put under the calls-long convention, and the mirror image under the other", () => {
    const skewed = chain([{ strike: 22_600, call: { openInterest: 300_000 }, put: { openInterest: 100_000 } }]);
    const a = buildExposure(skewed, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    const b = buildExposure(skewed, { spot: SPOT, forward: FORWARD, atmStrike: 22_600, convention: "puts-long" });
    expect(a.totals.netGex).toBeCloseTo(a.totals.callGex - a.totals.putGex, 4);
    expect(a.totals.netGex).toBeGreaterThan(0);
    expect(b.totals.netGex).toBeCloseTo(-a.totals.netGex, 4);
    expect(b.points[0]!.netGex).toBeCloseTo(-a.points[0]!.netGex!, 4);
    // The observed call and put exposures themselves do not depend on the assumption.
    expect(b.totals.callGex).toBeCloseTo(a.totals.callGex, 6);
    expect(b.totals.putGex).toBeCloseTo(a.totals.putGex, 6);
  });

  it("has no net figure for a strike where one side cannot be computed", () => {
    const result = buildExposure(chain([{ strike: 22_600, put: { impliedVolatility: null } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.points[0]!.netGex).toBeNull();
    expect(result.points[0]!.putGex).toBeNull();
    expect(result.points[0]!.callGex).not.toBeNull();
  });

  it("counts the legs it left out by reason and side, and leaves them out of the totals", () => {
    const result = buildExposure(
      chain([
        { strike: 22_500, call: { openInterest: null }, put: { impliedVolatility: null } },
        { strike: 22_600, call: { daysToExpiry: 0 }, put: null },
        { strike: 22_700 },
      ]),
      { spot: SPOT, forward: FORWARD, atmStrike: 22_600 },
    );
    expect(result.totals.excluded.call).toEqual({ noOpenInterest: 1, noImpliedVolatility: 0, noExpiry: 1 });
    expect(result.totals.excluded.put).toEqual({ noOpenInterest: 0, noImpliedVolatility: 1, noExpiry: 0 });
    const only = buildExposure(chain([{ strike: 22_700 }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.totals.callGex).toBeCloseTo(only.totals.callGex, 6);
  });

  it("falls back to spot for the forward and says so", () => {
    const withForward = buildExposure(strikes, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    const without = buildExposure(strikes, { spot: SPOT, forward: null, atmStrike: 22_600 });
    expect(withForward.forwardFromChain).toBe(true);
    expect(without.forwardFromChain).toBe(false);
    expect(without.forward).toBe(SPOT);
  });

  it("returns empty totals for an empty chain instead of failing", () => {
    const result = buildExposure([], { spot: SPOT, forward: FORWARD, atmStrike: null });
    expect(result.points).toEqual([]);
    expect(result.totals).toMatchObject({ strikesInChain: 0, lowestStrike: null, highestStrike: null, netGex: 0 });
    expect(result.flips).toEqual([]);
  });
});

describe("buildExposure: the sweep and the flip", () => {
  /** Put OI below spot and call OI above it, calls heavier: net (calls long) is positive at spot, negative well below it. */
  const split = chain([
    { strike: 22_400, call: { openInterest: 0 }, put: { openInterest: 100_000 } },
    { strike: 22_800, call: { openInterest: 150_000 }, put: { openInterest: 0 } },
  ]);

  it("covers -4% to +4% of spot in 0.2% steps, with the real spot in the middle", () => {
    const { sweep } = buildExposure(split, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(sweep).toHaveLength(41);
    expect(sweep[0]!.percent).toBe(-SWEEP_RANGE_PERCENT);
    expect(sweep[40]!.percent).toBe(SWEEP_RANGE_PERCENT);
    const middle = sweep[20]!;
    expect(middle.percent).toBe(0);
    expect(middle.spot).toBe(SPOT);
  });

  it("agrees with the totals at the real spot", () => {
    const result = buildExposure(split, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.sweep[20]!.netGex).toBeCloseTo(result.totals.netGex, 4);
    expect(result.sweep[20]!.callGex).toBeCloseTo(result.totals.callGex, 4);
  });

  it("finds where the net changes sign, and the net there is close to zero", () => {
    const result = buildExposure(split, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.totals.netGex).toBeGreaterThan(0);
    expect(result.flips.length).toBeGreaterThanOrEqual(1);
    const flip = result.flips[0]!;
    expect(flip.percent).toBeLessThan(0);
    expect(flip.above).toBe("positive");
    const atFlip = netGexAtSpot(split, { spot: SPOT, forward: FORWARD }, flip.spot, "calls-long");
    expect(Math.abs(atFlip)).toBeLessThan(0.02 * Math.abs(result.totals.callGex));
  });

  it("puts the flip at the same spot under the opposite convention, with the sign reversed", () => {
    const a = buildExposure(split, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    const b = buildExposure(split, { spot: SPOT, forward: FORWARD, atmStrike: 22_600, convention: "puts-long" });
    expect(b.flips[0]!.spot).toBeCloseTo(a.flips[0]!.spot, 6);
    expect(b.flips[0]!.above).toBe("negative");
  });

  it("reports no flip when the net never changes sign in the sweep", () => {
    const callsOnly = chain([{ strike: 22_600, call: { openInterest: 100_000 }, put: { openInterest: 0 } }]);
    const result = buildExposure(callsOnly, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.flips).toEqual([]);
    expect(result.sweep.every((p) => p.netGex >= 0)).toBe(true);
  });

  it("orders several flips by how near they are to the real spot", () => {
    // Heavy calls at the money, heavy puts either side: positive at spot, negative at both ends, so two changes of sign.
    const wide = chain([
      { strike: 21_900, call: { openInterest: 0 }, put: { openInterest: 200_000 } },
      { strike: 22_600, call: { openInterest: 400_000 }, put: { openInterest: 0 } },
      { strike: 23_300, call: { openInterest: 0 }, put: { openInterest: 200_000 } },
    ]);
    const { flips, totals } = buildExposure(wide, { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(totals.netGex).toBeGreaterThan(0);
    expect(flips).toHaveLength(2);
    expect(flips.map((f) => Math.sign(f.percent)).sort()).toEqual([-1, 1]);
    expect(flips.map((f) => f.above).sort()).toEqual(["negative", "positive"]);
    for (let i = 1; i < flips.length; i += 1) expect(Math.abs(flips[i]!.percent)).toBeGreaterThanOrEqual(Math.abs(flips[i - 1]!.percent));
  });
});

describe("buildExposure: the comparison with Fyers' gamma", () => {
  it("compares gamma x OI under the model and under Fyers' gamma over the strikes that have both", () => {
    const years = 7 / 365;
    const modelGamma = bsGamma(FORWARD * Math.exp(-RATE * years), 22_600, 0.15, years);
    const rounded = Math.round(modelGamma * 1e4) / 1e4; // Fyers reports four decimals
    const result = buildExposure(chain([{ strike: 22_600, call: { vendorGamma: rounded } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(result.vendor!.strikesCompared).toBe(1);
    expect(result.vendor!.ratio).toBeCloseTo(rounded / modelGamma, 6);
    expect(result.vendor!.modelGammaOi).toBeCloseTo(modelGamma * 100_000, 4);
  });

  it("is null when Fyers gave no gamma", () => {
    expect(buildExposure(chain([{ strike: 22_600 }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 }).vendor).toBeNull();
    expect(buildExposure(chain([{ strike: 22_600, call: { vendorGamma: null } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 }).vendor).toBeNull();
  });
});

describe("net share of gross", () => {
  it("is |net| over call + put exposure, and small when the two sides nearly balance", () => {
    const balanced = buildExposure(chain([{ strike: 22_600, call: { openInterest: 101_000 }, put: { openInterest: 100_000 } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(balanced.totals.netShareOfGross).toBeCloseTo(1_000 / 201_000, 6);
    expect(balanced.totals.netShareOfGross!).toBeLessThan(NET_NOISE_SHARE);
    const lopsided = buildExposure(chain([{ strike: 22_600, call: { openInterest: 300_000 }, put: { openInterest: 100_000 } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 });
    expect(lopsided.totals.netShareOfGross).toBeCloseTo(0.5, 6);
  });

  it("does not depend on the assumed convention", () => {
    const rows = chain([{ strike: 22_600, call: { openInterest: 300_000 }, put: { openInterest: 100_000 } }]);
    const a = buildExposure(rows, { spot: SPOT, forward: FORWARD, atmStrike: 22_600, convention: "calls-long" });
    const b = buildExposure(rows, { spot: SPOT, forward: FORWARD, atmStrike: 22_600, convention: "puts-long" });
    expect(a.totals.netShareOfGross).toBeCloseTo(b.totals.netShareOfGross!, 12);
  });

  it("is null when there is no exposure at all", () => {
    expect(buildExposure([], { spot: SPOT, forward: FORWARD, atmStrike: null }).totals.netShareOfGross).toBeNull();
    expect(buildExposure(chain([{ strike: 22_600, call: { openInterest: 0 }, put: { openInterest: 0 } }]), { spot: SPOT, forward: FORWARD, atmStrike: 22_600 }).totals.netShareOfGross).toBeNull();
  });
});

describe("formatFlipOffset", () => {
  it("says a sign change within five hundredths of a percent is at spot, never -0.0%", () => {
    expect(formatFlipOffset(-0.0003)).toBe("at spot");
    expect(formatFlipOffset(0.049)).toBe("at spot");
    expect(formatFlipOffset(-0.05)).toBe("-0.1%");
  });

  it("writes the sign and one decimal otherwise", () => {
    expect(formatFlipOffset(1.234)).toBe("+1.2%");
    expect(formatFlipOffset(-2.5)).toBe("-2.5%");
    expect(formatFlipOffset(Number.NaN)).toBe("—");
  });
});

describe("formatting", () => {
  it("writes rupees in lakh and crore with the sign kept", () => {
    expect(formatRupees(2.5e7)).toBe("₹2.50 Cr");
    expect(formatRupees(7_045.07e7)).toBe("₹7,045.07 Cr");
    expect(formatRupees(-1.25e5)).toBe("-₹1.25 L");
    expect(formatRupees(999)).toBe("₹999");
    expect(formatRupees(null)).toBe("—");
    expect(formatRupees(Number.NaN)).toBe("—");
  });

  it("writes delta-units compactly", () => {
    expect(formatDeltaUnits(250_000)).toBe("2.50 L");
    expect(formatDeltaUnits(-4_500)).toBe("-4.5 k");
    expect(formatDeltaUnits(12.34)).toBe("12.3");
    expect(formatDeltaUnits(null)).toBe("—");
  });
});

describe("axis helpers", () => {
  it("rounds an axis end up to 1, 2, 2.5, 5 or 10 times a power of ten", () => {
    expect(niceCeil(449.2)).toBe(500);
    expect(niceCeil(4.81e7)).toBe(5e7);
    expect(niceCeil(500)).toBe(500);
    expect(niceCeil(501)).toBe(1000);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(2.2)).toBe(2.5);
    expect(niceCeil(0.0003)).toBeCloseTo(0.0005, 12);
  });

  it("falls back to 1 for nothing to scale, instead of a zero-height axis", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
  });

  it("gives five evenly spaced ticks symmetric about zero, with zero among them", () => {
    expect(symmetricTicks(449.2)).toEqual([-500, -250, 0, 250, 500]);
    expect(symmetricTicks(4.81e7)).toEqual([-5e7, -2.5e7, 0, 2.5e7, 5e7]);
    for (const max of [3, 449.2, 1.7e6]) {
      const ticks = symmetricTicks(max);
      expect(ticks).toHaveLength(5);
      expect(ticks[2]).toBe(0);
      expect(ticks[4]).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(-ticks[4]!);
    }
  });

  it("writes every rupee tick in one unit chosen from the axis maximum, and zero as 0", () => {
    const crore = rupeeAxisFormatter(5e7);
    expect([-5e7, -2.5e7, 0, 2.5e7, 5e7].map(crore)).toEqual(["-₹5.00 Cr", "-₹2.50 Cr", "0", "₹2.50 Cr", "₹5.00 Cr"]);
    const lakh = rupeeAxisFormatter(4e5);
    expect([0, 1e5, 4e5].map(lakh)).toEqual(["0", "₹1.00 L", "₹4.00 L"]);
    expect(rupeeAxisFormatter(800)(400)).toBe("₹400");
  });

  it("uses fewer decimals for larger scaled values, so ticks stay short", () => {
    expect(rupeeAxisFormatter(5e7)(2.5e7)).toBe("₹2.50 Cr");   // axis max 5 Cr: two decimals
    expect(rupeeAxisFormatter(5e8)(2.5e8)).toBe("₹25.0 Cr");   // 50 Cr: one decimal
    expect(rupeeAxisFormatter(1.2e9)(6e8)).toBe("₹60 Cr");     // 120 Cr: none
  });

  it("does the same for delta-units: one unit, zero as 0", () => {
    const k = deltaUnitsAxisFormatter(500);
    expect([-500, -250, 0, 250, 500].map(k)).toEqual(["-500", "-250", "0", "250", "500"]);
    const thousands = deltaUnitsAxisFormatter(5000);
    expect([0, 2500, 5000].map(thousands)).toEqual(["0", "2.50 k", "5.00 k"]);
    expect(deltaUnitsAxisFormatter(2e5)(1e5)).toBe("1.00 L");
  });
});
