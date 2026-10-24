import { describe, expect, it } from "vitest";
import { buildPayoff, valueAtExpiry, type PayoffInput } from "./contract-payoff";

/** Synthetic contracts, hand-built for the arithmetic (not recorded from the API). */
const call = (overrides: Partial<PayoffInput> = {}): PayoffInput => ({
  optionType: "CE", strike: 54_300, ask: 336, spot: 54_300, oneSigmaToExpiryPoints: 800, ...overrides,
});

const put = (overrides: Partial<PayoffInput> = {}): PayoffInput => ({
  optionType: "PE", strike: 54_000, ask: 150, spot: 54_300, oneSigmaToExpiryPoints: 800, ...overrides,
});

const at = (payoff: NonNullable<ReturnType<typeof buildPayoff>>, level: number) => payoff.rows.find((row) => Math.abs(row.level - level) < 1e-6);

describe("valueAtExpiry", () => {
  it("is the distance past the strike in the money and zero otherwise", () => {
    expect(valueAtExpiry("CE", 100, 130)).toBe(30);
    expect(valueAtExpiry("CE", 100, 70)).toBe(0);
    expect(valueAtExpiry("PE", 100, 70)).toBe(30);
    expect(valueAtExpiry("PE", 100, 130)).toBe(0);
  });
});

describe("buildPayoff for a call", () => {
  // ATM call 54,300 bought at 336 with the index at 54,300: breakeven 54,636.
  const payoff = buildPayoff(call())!;

  it("tabulates the percent steps from the spot, with the strike merged into the spot row and the breakeven added", () => {
    expect(payoff.rows.map((row) => row.level)).toEqual([52_671, 53_214, 53_757, 54_028.5, 54_300, 54_571.5, 54_636, 54_843, 55_386, 55_929]);
    expect(at(payoff, 54_300)!.labels).toEqual(["spot", "strike"]);
    expect(at(payoff, 54_636)!.labels).toEqual(["breakeven"]);
  });

  it("loses exactly the ask at and below the strike, whatever the index does", () => {
    for (const level of [52_671, 53_214, 54_028.5, 54_300]) {
      expect(at(payoff, level)).toMatchObject({ intrinsicAtExpiry: 0, pnl: -336 });
      expect(at(payoff, level)!.pnlPercentOfAsk).toBeCloseTo(-100, 12);
    }
    expect(payoff.maxLoss).toBe(336);
  });

  it("breaks even at the strike plus the ask, and gains point for point above it", () => {
    expect(payoff.breakeven).toBe(54_636);
    expect(at(payoff, 54_636)!.pnl).toBeCloseTo(0, 9);
    // 54,843 is 543 past the strike: 543 - 336 = 207, which is 207 / 336 = 61.607% of the premium.
    expect(at(payoff, 54_843)).toMatchObject({ intrinsicAtExpiry: 543, pnl: 207 });
    expect(at(payoff, 54_843)!.pnlPercentOfAsk).toBeCloseTo((207 / 336) * 100, 12);
    expect(at(payoff, 55_929)!.pnl).toBe(1_629 - 336);
    // Between the strike and the breakeven the option is in the money but the position still loses: 54,571.5 gives 271.5 - 336.
    expect(at(payoff, 54_571.5)!.pnl).toBe(-64.5);
  });

  it("has no upper limit on a call's gain", () => {
    expect(payoff.maxGain).toBeNull();
  });

  it("gives each row its distance from the spot in points, percent and typical moves to expiry", () => {
    const row = at(payoff, 53_757)!;
    expect(row.moveFromSpotPoints).toBe(-543);
    expect(row.moveFromSpotPercent).toBeCloseTo(-1, 12);
    expect(row.sigmas).toBeCloseTo(-543 / 800, 12);      // -0.67875
  });
});

describe("buildPayoff for a put", () => {
  // Put 54,000 bought at 150 with the index at 54,300: breakeven 53,850, which is 450 below.
  const payoff = buildPayoff(put())!;

  it("breaks even at the strike minus the ask and caps the gain at the strike minus the ask", () => {
    expect(payoff.breakeven).toBe(53_850);
    expect(payoff.maxGain).toBe(53_850);
    expect(payoff.maxLoss).toBe(150);
  });

  it("is worth nothing above the strike (the whole premium is lost) and gains point for point below it", () => {
    expect(at(payoff, 54_300)).toMatchObject({ intrinsicAtExpiry: 0, pnl: -150 });
    expect(at(payoff, 54_028.5)).toMatchObject({ intrinsicAtExpiry: 0, pnl: -150 });
    // 53,757 is 243 under the strike: 243 - 150 = 93.
    expect(at(payoff, 53_757)).toMatchObject({ intrinsicAtExpiry: 243, pnl: 93 });
    // 53,214 is 786 under the strike: 786 - 150 = 636.
    expect(at(payoff, 53_214)).toMatchObject({ intrinsicAtExpiry: 786, pnl: 636 });
  });

  it("labels the strike and the breakeven on their own rows, and the spot on its own", () => {
    expect(at(payoff, 54_000)!.labels).toEqual(["strike"]);
    expect(at(payoff, 53_850)!.labels).toEqual(["breakeven"]);
    expect(at(payoff, 54_300)!.labels).toEqual(["spot"]);
  });
});

describe("buildPayoff with missing inputs", () => {
  it("is absent without a two-sided ask or a spot, rather than a line from a guessed price", () => {
    expect(buildPayoff(call({ ask: null }))).toBeNull();
    expect(buildPayoff(call({ ask: 0 }))).toBeNull();
    expect(buildPayoff(call({ spot: null }))).toBeNull();
  });

  it("keeps the arithmetic but has no distances in typical moves when the sigma is unknown", () => {
    const payoff = buildPayoff(call({ oneSigmaToExpiryPoints: null }))!;
    expect(payoff.rows.every((row) => row.sigmas === null)).toBe(true);
    expect(at(payoff, 54_843)!.pnl).toBe(207);
  });

  it("does not tabulate a negative index level", () => {
    const payoff = buildPayoff(put({ strike: 100, ask: 150, spot: 120 }))!;     // breakeven -50: nobody can reach it
    expect(payoff.rows.every((row) => row.level >= 0)).toBe(true);
    expect(payoff.rows.some((row) => row.labels.includes("breakeven"))).toBe(false);
    expect(payoff.maxGain).toBe(-50);
  });
});
