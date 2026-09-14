import { describe, expect, it } from "vitest";
import { resolveYahooSymbol } from "./yahoo-symbol-resolver.js";

/**
 * These tests exist because four HTTP routes each carried their own inline copy of this
 * mapping, and the copies had drifted: none handled INDIAVIX, and one spelled Fin Nifty
 * `FINNIFTY.NS`. Both failures were invisible -- a bad ticker returns no quote, which is
 * indistinguishable from a provider being briefly down -- so they are asserted here rather
 * than left to be noticed on a dashboard.
 */
describe("resolveYahooSymbol", () => {
  it("maps the index symbols Yahoo spells differently", () => {
    expect(resolveYahooSymbol("NIFTY50")).toBe("^NSEI");
    expect(resolveYahooSymbol("BANKNIFTY")).toBe("^NSEBANK");
    expect(resolveYahooSymbol("SENSEX")).toBe("^BSESN");
  });

  it("maps INDIAVIX, which every inline copy of this function omitted", () => {
    // The regime source (`regimeSourceInstrumentSymbol`). Falling through to the equity rule
    // produced `INDIAVIX.NS`, so `/live-price?symbol=INDIAVIX` answered 500.
    expect(resolveYahooSymbol("INDIAVIX")).toBe("^INDIAVIX");
    expect(resolveYahooSymbol("INDIAVIX")).not.toBe("INDIAVIX.NS");
  });

  it("maps FINNIFTY to the name Yahoo publishes, not the exchange's", () => {
    // The market-watch stream used `FINNIFTY.NS`; the quote rejected and the tile vanished.
    expect(resolveYahooSymbol("FINNIFTY")).toBe("NIFTY_FIN_SERVICE.NS");
    expect(resolveYahooSymbol("FINNIFTY")).not.toBe("FINNIFTY.NS");
  });

  it("treats an unmapped symbol as an NSE cash equity", () => {
    expect(resolveYahooSymbol("RELIANCE")).toBe("RELIANCE.NS");
    expect(resolveYahooSymbol("SBIN")).toBe("SBIN.NS");
  });

  it("maps equities whose NSE ticker was renamed, to the Yahoo name that still has history", () => {
    expect(resolveYahooSymbol("TATAMOTORS")).toBe("TMPV.NS");
    expect(resolveYahooSymbol("LTIM")).toBe("LTM.NS");
  });

  it("is case- and whitespace-insensitive, which the inline copies were not", () => {
    // `market-data.routes.ts` uppercased before matching and `paper-trading.routes.ts` did
    // not, so the same symbol resolved differently depending on which route received it.
    expect(resolveYahooSymbol("nifty50")).toBe("^NSEI");
    expect(resolveYahooSymbol("  BankNifty  ")).toBe("^NSEBANK");
    expect(resolveYahooSymbol("reliance")).toBe("RELIANCE.NS");
  });

  it("passes an already-qualified ticker through untouched", () => {
    // The market-watch panel quotes foreign indices by their Yahoo names directly.
    expect(resolveYahooSymbol("^GSPC")).toBe("^GSPC");
    expect(resolveYahooSymbol("^N225")).toBe("^N225");
    expect(resolveYahooSymbol("NIFTY_FIN_SERVICE.NS")).toBe("NIFTY_FIN_SERVICE.NS");
  });

  it("refuses an empty symbol instead of asking the provider for `.NS`", () => {
    expect(() => resolveYahooSymbol("")).toThrow(/empty symbol/i);
    expect(() => resolveYahooSymbol("   ")).toThrow(/empty symbol/i);
  });
});
