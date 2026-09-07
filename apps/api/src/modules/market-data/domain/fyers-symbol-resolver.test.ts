import { describe, expect, it } from "vitest";
import { resolveFyersSymbol } from "./fyers-symbol-resolver.js";

describe("resolveFyersSymbol", () => {
  it.each([
    ["NIFTY50", "NSE:NIFTY50-INDEX"],
    // Fyers spells Bank Nifty NIFTYBANK; passing BANKNIFTY through would 404.
    ["BANKNIFTY", "NSE:NIFTYBANK-INDEX"],
    ["INDIAVIX", "NSE:INDIAVIX-INDEX"],
  ])("maps the index %s to %s", (input, expected) => {
    expect(resolveFyersSymbol(input)).toBe(expected);
  });

  it.each([["SBIN", "NSE:SBIN-EQ"], ["reliance", "NSE:RELIANCE-EQ"]])(
    "treats %s as an NSE cash equity",
    (input, expected) => {
      expect(resolveFyersSymbol(input)).toBe(expected);
    },
  );

  // The escape hatch for futures and options, whose contract naming this
  // resolver deliberately does not model.
  it("passes through an already-qualified Fyers symbol", () => {
    expect(resolveFyersSymbol("NSE:NIFTY26AUGFUT")).toBe("NSE:NIFTY26AUGFUT");
  });

  it("rejects an empty symbol rather than building NSE:-EQ", () => {
    expect(() => resolveFyersSymbol("   ")).toThrow(/empty symbol/);
  });
});
