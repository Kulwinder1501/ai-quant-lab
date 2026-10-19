import { describe, expect, it } from "vitest";
import { chainStreamSymbols, parseChainStreamStrikes } from "./chain-stream-window.js";

function chain(strikes: number[]) {
  return strikes.flatMap((strikePrice) => [
    { strikePrice, providerSymbol: `NSE:X${strikePrice}CE` },
    { strikePrice, providerSymbol: `NSE:X${strikePrice}PE` },
  ]);
}

const THIRTY_ONE_STRIKES = Array.from({ length: 31 }, (_, index) => 54_100 + index * 100);

describe("chainStreamSymbols", () => {
  it("takes the thirteen strikes around the money, calls and puts, out of a 31-strike chain", () => {
    const symbols = chainStreamSymbols(chain(THIRTY_ONE_STRIKES), 55_600, 6);
    expect(symbols).toHaveLength(26);
    expect(symbols).toContain("NSE:X55600CE");
    expect(symbols).toContain("NSE:X55000PE");
    expect(symbols).toContain("NSE:X56200CE");
    expect(symbols).not.toContain("NSE:X54900CE");
    expect(symbols).not.toContain("NSE:X56300CE");
  });

  it("centres on the strike nearest the live spot, not on a round number", () => {
    const symbols = chainStreamSymbols(chain(THIRTY_ONE_STRIKES), 55_641, 2);
    expect(symbols.map((s) => s.replace(/\D/g, "")).sort()).toEqual(
      ["55400", "55400", "55500", "55500", "55600", "55600", "55700", "55700", "55800", "55800"],
    );
  });

  it("narrows at the edge of the chain rather than reaching past it", () => {
    const symbols = chainStreamSymbols(chain([100, 200, 300]), 100, 6);
    expect(symbols).toHaveLength(6);
  });

  it("returns everything for \"all\" and when the spot is unknown", () => {
    expect(chainStreamSymbols(chain(THIRTY_ONE_STRIKES), 55_600, "all")).toHaveLength(62);
    expect(chainStreamSymbols(chain(THIRTY_ONE_STRIKES), null, 6)).toHaveLength(62);
  });

  it("skips contracts that have no provider symbol", () => {
    const symbols = chainStreamSymbols([{ strikePrice: 100, providerSymbol: null }, { strikePrice: 100, providerSymbol: "NSE:A" }], 100, 6);
    expect(symbols).toEqual(["NSE:A"]);
  });
});

describe("parseChainStreamStrikes", () => {
  it("defaults, caps and accepts all", () => {
    expect(parseChainStreamStrikes(undefined)).toBe(6);
    expect(parseChainStreamStrikes("abc")).toBe(6);
    expect(parseChainStreamStrikes("0")).toBe(6);
    expect(parseChainStreamStrikes("10")).toBe(10);
    expect(parseChainStreamStrikes("99")).toBe(15);
    expect(parseChainStreamStrikes("all")).toBe("all");
  });
});
