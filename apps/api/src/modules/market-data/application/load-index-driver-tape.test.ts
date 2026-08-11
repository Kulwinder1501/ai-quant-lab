import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YahooQuote } from "../../../infrastructure/market-data/yahoo-quote-client.js";

// The service reads live quotes through the module-level `quoteLabSymbols`, so it is mocked here;
// the driver universe and contribution math are the real ones, which is what makes the coverage
// arithmetic worth asserting (coverage = quoted / full roster).
vi.mock("../../../infrastructure/market-data/yahoo-quote-client.js", () => ({
  quoteLabSymbols: vi.fn(),
}));

import { quoteLabSymbols } from "../../../infrastructure/market-data/yahoo-quote-client.js";
import { resolveIndexDriverUniverse } from "../domain/nifty50-driver-weights.js";
import { loadIndexDriverTape } from "./load-index-driver-tape.js";

const mockQuotes = vi.mocked(quoteLabSymbols);
const universe = resolveIndexDriverUniverse("NIFTY50")!;

/** A YahooQuote with only the two fields the tape reads set; the rest are honest nulls. */
function quote(price: number | null, changePercent: number | null): YahooQuote {
  return {
    symbol: "x",
    shortName: null,
    exchange: null,
    regularMarketPrice: price,
    regularMarketPreviousClose: null,
    regularMarketChange: null,
    regularMarketChangePercent: changePercent,
    regularMarketOpen: null,
    regularMarketDayHigh: null,
    regularMarketDayLow: null,
    regularMarketVolume: null,
    regularMarketTime: null,
  };
}

/** Builds the quote map: the index, plus the first `quotedDrivers` roster names at `dayPct`. */
function quoteMap(indexPct: number, quotedDrivers: number, dayPct: number): Map<string, YahooQuote> {
  const map = new Map<string, YahooQuote>();
  map.set(universe.yahooIndexSymbol, quote(24_000, indexPct));
  for (const driver of universe.drivers.slice(0, quotedDrivers)) {
    map.set(driver.symbol, quote(100, dayPct));
  }
  return map;
}

describe("loadIndexDriverTape", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an index with no driver universe, without quoting anything", async () => {
    const result = await loadIndexDriverTape("HANGSENG");
    expect(result).toBeNull();
    expect(mockQuotes).not.toHaveBeenCalled();
  });

  it("computes full coverage and unanimous breadth when every driver quotes with one sign", async () => {
    mockQuotes.mockResolvedValue(quoteMap(0.5, universe.drivers.length, 1.2));

    const result = await loadIndexDriverTape("NIFTY50");

    expect(result).not.toBeNull();
    expect(result!.drivers).toHaveLength(universe.drivers.length);
    expect(result!.tape).not.toBeNull();
    expect(result!.tape!.coverage).toBe(1);
    expect(result!.tape!.advanceShare).toBe(1);
    expect(result!.tape!.declineShare).toBe(0);
    expect(result!.tape!.rosterCount).toBe(universe.drivers.length);
    // Every driver moved up, so every contribution is positive and the net is too.
    expect(result!.estNetPts).toBeGreaterThan(0);
  });

  it("measures coverage against the full roster, not the quoted subset", async () => {
    // This is the seam the service owns: pass the roster length, not the filtered length, so a
    // partial Yahoo response reads as low coverage rather than a false 100%.
    const quoted = Math.max(1, Math.floor(universe.drivers.length / 3));
    mockQuotes.mockResolvedValue(quoteMap(0.5, quoted, 1.0));

    const result = await loadIndexDriverTape("NIFTY50");

    expect(result!.drivers).toHaveLength(quoted);
    expect(result!.tape!.quotedCount).toBe(quoted);
    expect(result!.tape!.rosterCount).toBe(universe.drivers.length);
    expect(result!.tape!.coverage).toBeCloseTo(quoted / universe.drivers.length, 6);
    expect(result!.tape!.coverage).toBeLessThan(1);
  });

  it("drops a driver whose quote has no change percent rather than scoring it as flat", async () => {
    const map = quoteMap(0.5, universe.drivers.length, 1.0);
    // One quoted name comes back with a null change percent: it must be excluded, not read as 0.
    map.set(universe.drivers[0]!.symbol, quote(100, null));
    mockQuotes.mockResolvedValue(map);

    const result = await loadIndexDriverTape("NIFTY50");

    expect(result!.drivers).toHaveLength(universe.drivers.length - 1);
    expect(result!.drivers.some((row) => row.symbol === universe.drivers[0]!.symbol)).toBe(false);
    expect(result!.tape!.quotedCount).toBe(universe.drivers.length - 1);
  });

  it("carries a null index level through without inventing contribution points", async () => {
    // Index quote missing its price: contributions need the index level, so with none there are
    // no driver rows and no tape -- an honest empty, not a fabricated one.
    const map = new Map<string, YahooQuote>();
    map.set(universe.yahooIndexSymbol, quote(null, null));
    for (const driver of universe.drivers) map.set(driver.symbol, quote(100, 1.0));
    mockQuotes.mockResolvedValue(map);

    const result = await loadIndexDriverTape("NIFTY50");

    expect(result!.indexLevel).toBeNull();
    expect(result!.drivers).toHaveLength(0);
    expect(result!.tape).toBeNull();
  });
});
