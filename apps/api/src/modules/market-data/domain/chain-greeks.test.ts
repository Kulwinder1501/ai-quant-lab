import { describe, expect, it } from "vitest";
import { solveContractGreeksFromChain } from "./chain-greeks.js";
import type { OptionChainQuote, OptionChainSnapshot } from "./option-chain.js";

const EXPIRY = new Date("2026-08-25T10:00:00.000Z");
const OBSERVED = new Date("2026-08-05T06:45:00.000Z");

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: EXPIRY,
    expiryKind: "MONTHLY",
    strikePrice: 57_700,
    optionType: "CE",
    providerSymbol: "NSE:BANKNIFTY26AUG57700CE",
    providerToken: null,
    lastPrice: 812,
    bid: 811.45,
    ask: 813.55,
    volume: 1_000,
    openInterest: 5_000,
    previousOpenInterest: 4_800,
    openInterestChange: 200,
    ...overrides,
  };
}

/** A paired book, so put-call parity can supply the forward. */
function snapshot(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observedAt: OBSERVED,
    underlyingValue: 57_684.35,
    quotes: [
      quote(),
      quote({ optionType: "PE", bid: 700.1, ask: 702.4, lastPrice: 701 }),
      quote({ strikePrice: 57_600, bid: 872.0, ask: 874.5 }),
      quote({ strikePrice: 57_600, optionType: "PE", bid: 660.5, ask: 662.8 }),
    ],
    listedExpiries: [{ expiryDate: EXPIRY, expiryKind: "MONTHLY" }],
    ...overrides,
  };
}

describe("solveContractGreeksFromChain", () => {
  it("solves a delta in (0,1) for a near-the-money call, with negative theta", () => {
    const solved = solveContractGreeksFromChain({
      snapshot: snapshot(), strikePrice: 57_700, optionType: "CE",
    });

    expect(solved).not.toBeNull();
    expect(solved!.delta).toBeGreaterThan(0);
    expect(solved!.delta).toBeLessThan(1);
    // A long option decays; a positive theta here would mean the holder is paid to wait.
    expect(solved!.theta).toBeLessThan(0);
    expect(solved!.vega).toBeGreaterThan(0);
    expect(solved!.impliedVolatility).toBeGreaterThan(0);
  });

  it("gives a put a negative delta", () => {
    const solved = solveContractGreeksFromChain({
      snapshot: snapshot(), strikePrice: 57_700, optionType: "PE",
    });

    expect(solved).not.toBeNull();
    expect(solved!.delta).toBeLessThan(0);
    expect(solved!.delta).toBeGreaterThan(-1);
  });

  it("prices against the parity forward, not spot discounted at r", () => {
    // The forward this book implies sits below spot, as it does for a dividend-paying index.
    // Using S*e^(rT) instead moved a live BANKNIFTY delta from 0.51 to 0.61, so the two must
    // not agree -- if they do, the parity correction is not being applied.
    const withParity = solveContractGreeksFromChain({
      snapshot: snapshot(), strikePrice: 57_700, optionType: "CE",
    });
    // Strip the pairs so no forward can be derived and spot is used instead.
    const spotOnly = solveContractGreeksFromChain({
      snapshot: snapshot({ quotes: [quote()] }), strikePrice: 57_700, optionType: "CE",
    });

    expect(withParity).not.toBeNull();
    expect(spotOnly).not.toBeNull();
    expect(withParity!.delta).not.toBeCloseTo(spotOnly!.delta, 4);
  });

  it("returns null for a contract the chain does not carry", () => {
    expect(solveContractGreeksFromChain({
      snapshot: snapshot(), strikePrice: 99_000, optionType: "CE",
    })).toBeNull();
  });

  it("returns null when the contract has no two-sided quote", () => {
    // Unknown, not zero. A one-sided market has no mid to invert.
    expect(solveContractGreeksFromChain({
      snapshot: snapshot({ quotes: [quote({ bid: null }), quote({ optionType: "PE" })] }),
      strikePrice: 57_700,
      optionType: "CE",
    })).toBeNull();
  });

  it("returns null once the contract has expired", () => {
    expect(solveContractGreeksFromChain({
      snapshot: snapshot({ observedAt: new Date("2026-08-26T06:45:00.000Z") }),
      strikePrice: 57_700,
      optionType: "CE",
    })).toBeNull();
  });

  it("returns null when neither a forward nor a spot is available", () => {
    expect(solveContractGreeksFromChain({
      snapshot: snapshot({ underlyingValue: null, quotes: [quote()] }),
      strikePrice: 57_700,
      optionType: "CE",
    })).toBeNull();
  });
});
