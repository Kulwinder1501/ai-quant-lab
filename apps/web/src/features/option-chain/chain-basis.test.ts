import { describe, expect, it } from "vitest";
import {
  basisSentence,
  buildChainBasis,
  greeksSufficiency,
  impliedMoveSufficiency,
  quoteSufficiency,
  type ChainBasis,
  type ChainBasisInput,
} from "./chain-basis";

/** Synthetic chain, hand-built for the counting (not recorded from the API). */
type Leg = NonNullable<ChainBasisInput["strikes"][number]["call"]>;
const leg = (bid: number | null, ask: number | null, iv: number | null, refusal: string | null = null, vendor = false): Leg => ({
  lastPrice: null, bid, ask, volume: null, openInterest: null, openInterestChange: null, spreadAbsolute: null, spreadPercentOfMid: null,
  withinCostBudget: null, moneyness: null, providerSymbol: "x", impliedVolatility: iv, impliedVolatilityRefusal: refusal,
  delta: null, gamma: null, theta: null, vega: null, daysToExpiry: 4, vendorGreeks: vendor ? { delta: 0.5, gamma: 0.0004, theta: -12, vega: 30, impliedVolatilityPercent: 15 } : null,
});

const strikes: ChainBasisInput["strikes"] = [
  { strikePrice: 54_000, call: leg(380, 386, 0.16), put: leg(100, 104, 0.16, null, true) },
  { strikePrice: 54_300, call: leg(330, 336, 0.15), put: leg(310, 316, 0.15) },
  { strikePrice: 54_600, call: leg(0, 90, null, "NO_TWO_SIDED_QUOTE"), put: leg(380, 386, null, "BELOW_INTRINSIC") },
  { strikePrice: 54_900, call: leg(200, 206, 0.17), put: null },
];

const basis = (overrides: Partial<ChainBasisInput> = {}) => buildChainBasis({ strikes, atmStrike: 54_300, atmImpliedVolatility: 0.15, ...overrides });

describe("buildChainBasis", () => {
  it("counts the contracts that exist, the two-sided ones, the solved ones and the provider Greeks", () => {
    expect(basis()).toMatchObject({
      strikeCount: 4, strikeLow: 54_000, strikeHigh: 54_900,
      legs: 7,            // 54,900 has no put: one leg, not two
      twoSided: 6,        // all but the 54,600 call (a zero bid is nobody bidding)
      ivSolved: 5,        // 54,000 x2, 54,300 x2, 54,900 call
      vendorGreeks: 1,
    });
  });

  it("says why the rest were not solved, most common first, ties by reason", () => {
    expect(basis().ivRefusals).toEqual([{ reason: "BELOW_INTRINSIC", count: 1 }, { reason: "NO_TWO_SIDED_QUOTE", count: 1 }]);
  });

  it("reads the ATM pair: both legs two-sided and the ATM volatility solved", () => {
    expect(basis().atm).toEqual({ strike: 54_300, callTwoSided: true, putTwoSided: true, ivSolved: true });
    expect(basis({ atmStrike: 54_600 }).atm).toMatchObject({ callTwoSided: false, putTwoSided: true });
    expect(basis({ atmImpliedVolatility: null }).atm.ivSolved).toBe(false);
    expect(basis({ atmStrike: null }).atm).toMatchObject({ strike: null, callTwoSided: false, putTwoSided: false });
  });

  it("is empty, not an error, for a chain with no strike", () => {
    expect(buildChainBasis({ strikes: [], atmStrike: null, atmImpliedVolatility: null })).toMatchObject({ strikeCount: 0, strikeLow: null, strikeHigh: null, legs: 0, twoSided: 0, ivSolved: 0, ivRefusals: [] });
  });
});

describe("sufficiency rules", () => {
  it("rates the quoted share: 80% or more enough, 50% or more partial, less thin", () => {
    expect(quoteSufficiency(basis())).toEqual({ level: "enough", text: "6 of 7 contracts have a two-sided quote (86%)" });
    const at = (twoSided: number): ChainBasis => ({ ...basis(), legs: 10, twoSided });
    expect(quoteSufficiency(at(8)).level).toBe("enough");       // exactly 80%
    expect(quoteSufficiency(at(7)).level).toBe("partial");
    expect(quoteSufficiency(at(5)).level).toBe("partial");      // exactly 50%
    expect(quoteSufficiency(at(4)).level).toBe("thin");
  });

  it("rates the solved share the same way, for the Greeks", () => {
    expect(greeksSufficiency(basis())).toEqual({ level: "partial", text: "a volatility is solved for 5 of 7 contracts (71%)" });
  });

  it("cannot rate a chain with no contract", () => {
    const empty = buildChainBasis({ strikes: [], atmStrike: null, atmImpliedVolatility: null });
    expect(quoteSufficiency(empty).level).toBe("cannot");
    expect(greeksSufficiency(empty).level).toBe("cannot");
  });

  it("rates the implied move on the ATM pair: enough, partial for either half missing, cannot for both", () => {
    expect(impliedMoveSufficiency(basis())).toEqual({ level: "enough", text: "the 54300 straddle is quoted on both sides and its volatility is solved" });
    expect(impliedMoveSufficiency(basis({ atmImpliedVolatility: null }))).toMatchObject({ level: "partial", text: expect.stringContaining("no typical-move band") });
    expect(impliedMoveSufficiency(basis({ atmStrike: 54_600 }))).toMatchObject({ level: "partial", text: expect.stringContaining("not quoted on both sides") });
    expect(impliedMoveSufficiency(basis({ atmStrike: 54_600, atmImpliedVolatility: null })).level).toBe("cannot");
  });
});

describe("basisSentence", () => {
  it("states the strikes, the contracts, what was not solved and why, and whether provider Greeks are stored", () => {
    expect(basisSentence(basis())).toBe(
      "One stored snapshot: 4 strikes from 54,000 to 54,900, 7 contracts. Not solved: 1 below intrinsic, 1 no two sided quote. Fyers' own Greeks are stored for 1 of them.",
    );
  });

  it("says plainly when no provider Greeks are stored, and when the chain is empty", () => {
    const noVendor = buildChainBasis({ strikes: [{ strikePrice: 54_300, call: leg(330, 336, 0.15), put: leg(310, 316, 0.15) }], atmStrike: 54_300, atmImpliedVolatility: 0.15 });
    expect(basisSentence(noVendor)).toContain("No Fyers Greeks are stored for this snapshot");
    expect(basisSentence(buildChainBasis({ strikes: [], atmStrike: null, atmImpliedVolatility: null }))).toBe("The stored chain holds no strike.");
  });
});
