import { describe, expect, it } from "vitest";
import { applyChainTick, type ChainResponse, type Leg } from "./live-chain";

function leg(providerSymbol: string, overrides: Partial<Leg> = {}): Leg {
  return {
    lastPrice: 100, bid: 99, ask: 101, volume: 10, openInterest: 1000, openInterestChange: 0,
    spreadAbsolute: 2, spreadPercentOfMid: 2, withinCostBudget: false, moneyness: "ATM",
    providerSymbol, impliedVolatility: 0.15, impliedVolatilityRefusal: null,
    delta: 0.5, gamma: 0.001, theta: -10, vega: 12, daysToExpiry: 7,
    ...overrides,
  };
}

function chain(): ChainResponse {
  return {
    underlyingSymbol: "NIFTY50",
    available: true,
    underlyingValue: 22350,
    strikes: [
      { strikePrice: 22300, isAtm: false, call: leg("NSE:NIFTY26OCT22300CE"), put: leg("NSE:NIFTY26OCT22300PE") },
      { strikePrice: 22350, isAtm: true, call: leg("NSE:NIFTY26OCT22350CE"), put: leg("NSE:NIFTY26OCT22350PE") },
    ],
  };
}

describe("applyChainTick", () => {
  it("passes a missing chain straight through", () => {
    expect(applyChainTick(null, { symbol: "NSE:NIFTY26OCT22350CE", ask: 120 })).toBeNull();
  });

  it("takes the new quote on the leg that ticked and leaves every other leg alone", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTY26OCT22350CE", bid: 119, ask: 121, ltp: 120 })!;
    const ticked = after.strikes![1]!.call!;
    expect(ticked.bid).toBe(119);
    expect(ticked.ask).toBe(121);
    expect(ticked.lastPrice).toBe(120);
    // Untouched legs are the same objects, not copies re-solved against a quote that did not move.
    expect(after.strikes![1]!.put).toBe(before.strikes![1]!.put);
    expect(after.strikes![0]!.call).toBe(before.strikes![0]!.call);
  });

  it("does not mutate the chain it was given", () => {
    const before = chain();
    const snapshot = JSON.stringify(before);
    applyChainTick(before, { symbol: "NSE:NIFTY26OCT22350CE", bid: 119, ask: 121 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("returns the same chain when the tick matches nothing in it", () => {
    const before = chain();
    expect(applyChainTick(before, { symbol: "NSE:BANKNIFTY26OCTFUT", ask: 5 })).toBe(before);
  });

  it("moves the spot on an index tick and re-solves every leg against it", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTY50-INDEX", ltp: 22400 })!;
    expect(after.underlyingValue).toBe(22400);
    expect(after.strikes![0]!.call).not.toBe(before.strikes![0]!.call);
    // The quotes themselves are unchanged: only an option's own tick moves its bid and ask.
    expect(after.strikes![0]!.call!.ask).toBe(101);
  });

  it("moves the spot on a Bank Nifty index tick", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTYBANK-INDEX", ltp: 55700 })!;
    expect(after.underlyingValue).toBe(55700);
  });

  it("moves the spot on an equity underlying tick", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:SBIN-EQ", ltp: 820 })!;
    expect(after.underlyingValue).toBe(820);
  });

  it("keeps the previous quote for a field the tick does not carry", () => {
    const after = applyChainTick(chain(), { symbol: "NSE:NIFTY26OCT22350CE", ask: 130 })!;
    const ticked = after.strikes![1]!.call!;
    expect(ticked.ask).toBe(130);
    expect(ticked.bid).toBe(99);
  });
});
