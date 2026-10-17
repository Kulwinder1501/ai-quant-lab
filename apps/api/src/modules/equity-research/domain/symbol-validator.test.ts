import { describe, expect, it } from "vitest";
import { isValidExchange, isValidSymbol, validateEquityIdentity } from "./symbol-validator.js";

describe("Equity symbol and identity validation (Gate S1)", () => {
  it("accepts valid NSE and BSE ticker symbols", () => {
    expect(isValidSymbol("SUZLON")).toBe(true);
    expect(isValidSymbol("RELIANCE")).toBe(true);
    expect(isValidSymbol("TCS")).toBe(true);
    expect(isValidSymbol("M&M")).toBe(true);
    expect(isValidSymbol("BAJAJ-AUTO")).toBe(true);
    expect(isValidSymbol("500325")).toBe(true); // BSE numerical code
  });

  it("rejects malicious, malformed, empty, lowercase, or overly long symbols", () => {
    expect(isValidSymbol("")).toBe(false);
    expect(isValidSymbol("SUZLON;DROP")).toBe(false);
    expect(isValidSymbol("suzlon")).toBe(false);
    expect(isValidSymbol("SUZLON ENERGY")).toBe(false);
    expect(isValidSymbol("VERYLONGSYMBOLNAMETHATEXCEEDS20CHARS")).toBe(false);
    expect(isValidSymbol("<script>")).toBe(false);
    expect(isValidSymbol("TCS.NS")).toBe(false); // Exchange suffix not allowed in root symbol
  });

  it("validates exchanges and constructs proper Yahoo symbols", () => {
    expect(isValidExchange("NSE")).toBe(true);
    expect(isValidExchange("BSE")).toBe(true);
    expect(isValidExchange("NASDAQ")).toBe(false);

    const nse = validateEquityIdentity("SUZLON", "NSE");
    expect(nse.yahooSymbol).toBe("SUZLON.NS");
    expect(nse.symbol).toBe("SUZLON");
    expect(nse.exchange).toBe("NSE");

    const bse = validateEquityIdentity("SUZLON", "BSE");
    expect(bse.yahooSymbol).toBe("SUZLON.BO");
    expect(bse.symbol).toBe("SUZLON");
    expect(bse.exchange).toBe("BSE");
  });

  it("throws informative errors on invalid input", () => {
    expect(() => validateEquityIdentity("SUZLON;DROP", "NSE")).toThrow(/Invalid symbol/);
    expect(() => validateEquityIdentity("SUZLON", "NYSE")).toThrow(/Invalid exchange/);
  });
});
