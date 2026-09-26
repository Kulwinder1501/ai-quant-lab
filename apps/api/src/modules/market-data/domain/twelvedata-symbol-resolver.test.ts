import { describe, expect, it } from "vitest";
import { resolveTwelveDataSymbol } from "./twelvedata-symbol-resolver.js";

describe("resolveTwelveDataSymbol", () => {
  it("maps the canonical underscore symbol to Twelve Data's slash notation", () => {
    expect(resolveTwelveDataSymbol("XAU_USD")).toBe("XAU/USD");
    expect(resolveTwelveDataSymbol("xau_usd")).toBe("XAU/USD");
  });

  it("passes an already-slash-qualified symbol through untouched", () => {
    expect(resolveTwelveDataSymbol("EUR/USD")).toBe("EUR/USD");
  });

  it("throws for an unmapped symbol rather than guessing an NSE-style default", () => {
    // Unlike resolveFyersSymbol/resolveYahooSymbol, there is no sane default venue for a
    // global data vendor -- a wrong guess here would silently request the wrong instrument.
    expect(() => resolveTwelveDataSymbol("UNKNOWN")).toThrow(/No Twelve Data symbol mapping/);
  });

  it("rejects an empty symbol", () => {
    expect(() => resolveTwelveDataSymbol("  ")).toThrow(/empty symbol/);
  });
});
