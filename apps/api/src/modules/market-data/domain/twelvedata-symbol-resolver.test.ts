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

  it("maps the 6 real DXY component pairs used by compute-synthetic-dxy.ts", () => {
    expect(resolveTwelveDataSymbol("EUR_USD")).toBe("EUR/USD");
    expect(resolveTwelveDataSymbol("USD_JPY")).toBe("USD/JPY");
    expect(resolveTwelveDataSymbol("GBP_USD")).toBe("GBP/USD");
    expect(resolveTwelveDataSymbol("USD_CAD")).toBe("USD/CAD");
    expect(resolveTwelveDataSymbol("USD_SEK")).toBe("USD/SEK");
    expect(resolveTwelveDataSymbol("USD_CHF")).toBe("USD/CHF");
  });

  it("throws for DXY rather than requesting a ticker Twelve Data does not sell", () => {
    // Confirmed 2026-10-06 against Twelve Data's live /indices catalog: no symbol or name match
    // for the US Dollar Index anywhere in 1,308 entries. Resolving "DXY" here used to return the
    // literal string "DXY", which Twelve Data's API rejected with HTTP 404 on every request.
    expect(() => resolveTwelveDataSymbol("DXY")).toThrow(/No Twelve Data symbol mapping/);
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
