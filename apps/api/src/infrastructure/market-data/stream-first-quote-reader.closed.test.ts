import { describe, expect, it } from "vitest";
import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { StreamFirstQuoteReader, type StreamTickSource } from "./stream-first-quote-reader.js";

function quote(symbol: string, price: number): MarketQuote {
  return {
    symbol,
    provider: "fyers-api-v3",
    shortName: symbol,
    exchange: "NSE",
    regularMarketPrice: price,
    regularMarketPreviousClose: 22_623,
    regularMarketChange: price - 22_623,
    regularMarketChangePercent: ((price - 22_623) / 22_623) * 100,
    regularMarketOpen: 22_671,
    regularMarketDayHigh: 23_056,
    regularMarketDayLow: 22_637,
    regularMarketVolume: 1_000,
    regularMarketTime: new Date("2026-10-19T10:00:00Z"),
  };
}

function setup(options: { open?: boolean; budgetAllows?: boolean; tick?: number | null } = {}) {
  let now = 1_000_000;
  const state = { open: options.open ?? false, budgetAllows: options.budgetAllows ?? true, tick: options.tick ?? null as number | null };
  const innerCalls: string[][] = [];
  const inner: MarketQuoteReader = {
    quoteSymbol: async (symbol) => (await inner.quoteSymbols([symbol])).get(symbol) ?? null,
    quoteSymbols: async (symbols) => {
      innerCalls.push([...symbols]);
      return new Map(symbols.map((symbol) => [symbol, quote(symbol, 22_956)]));
    },
  };
  const ticks: StreamTickSource = {
    lastPrice: (_symbol, maxAgeMs, at = now) =>
      state.tick === null || at - now > maxAgeMs ? null : { price: state.tick, observedAt: new Date(now) },
  };
  const reader = new StreamFirstQuoteReader({
    inner,
    ticks,
    subscriber: { subscribe: () => undefined },
    now: () => now,
    isSessionOpen: () => state.open,
    restBudget: { allow: () => state.budgetAllows },
  });
  return { reader, innerCalls, state, advance: (ms: number) => { now += ms; } };
}

describe("StreamFirstQuoteReader with the session closed", () => {
  it("makes at most one REST call per symbol set over ten minutes of 2.5 second polling, for two streams", async () => {
    const { reader, innerCalls, advance } = setup({ open: false });
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 2_500) {
      await reader.quoteSymbols(["NIFTY50"]);
      await reader.quoteSymbols(["BANKNIFTY"]);
      advance(2_500);
    }
    // 2 keys, 240 polls each: the first call of each fetches, every other is the held quote.
    expect(innerCalls).toEqual([["NIFTY50"], ["BANKNIFTY"]]);
  });

  it("refreshes a held quote only after it is thirty minutes old", async () => {
    const { reader, innerCalls, advance } = setup({ open: false });
    await reader.quoteSymbols(["NIFTY50"]);
    advance(29 * 60_000);
    await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(1);
    advance(2 * 60_000);
    await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(2);
  });

  it("answers a large set (the heatmap) from the held quotes too, and holds it after the first fetch", async () => {
    const { reader, innerCalls, advance } = setup({ open: false });
    const constituents = Array.from({ length: 50 }, (_, index) => `STOCK${index}`);
    await reader.quoteSymbols(constituents);
    advance(60_000);
    const quotes = await reader.quoteSymbols(constituents);
    expect(innerCalls).toEqual([constituents]);
    expect(quotes.size).toBe(50);
  });

  it("fetches normally in an open session", async () => {
    const { reader, innerCalls, advance } = setup({ open: true });
    await reader.quoteSymbols(["NIFTY50"]);
    advance(60_000);
    await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(2);
  });
});

describe("StreamFirstQuoteReader when the browser's quote budget is spent", () => {
  it("serves the held quote even in an open session, laying a fresh tick over it", async () => {
    const { reader, innerCalls, state, advance } = setup({ open: true });
    await reader.quoteSymbols(["NIFTY50"]);
    state.budgetAllows = false;
    state.tick = 22_990;
    advance(20 * 60_000);

    const served = (await reader.quoteSymbols(["NIFTY50"])).get("NIFTY50");
    expect(innerCalls).toHaveLength(1);
    expect(served?.regularMarketPrice).toBe(22_990);
  });

  it("still fetches a symbol it has never held, so a new panel is not left blank", async () => {
    const { reader, innerCalls, state } = setup({ open: true });
    state.budgetAllows = false;
    await reader.quoteSymbols(["BANKNIFTY"]);
    expect(innerCalls).toEqual([["BANKNIFTY"]]);
  });
});

describe("StreamFirstQuoteReader REST floor when ticks are missing", () => {
  function floorSetup() {
    let now = 1_000_000;
    const innerCalls: string[][] = [];
    const inner: MarketQuoteReader = {
      quoteSymbol: async (symbol) => (await inner.quoteSymbols([symbol])).get(symbol) ?? null,
      quoteSymbols: async (symbols) => {
        innerCalls.push([...symbols]);
        return new Map(symbols.map((symbol) => [symbol, quote(symbol, 22_956)]));
      },
    };
    const reader = new StreamFirstQuoteReader({
      inner,
      ticks: { lastPrice: () => null },
      subscriber: { subscribe: () => undefined },
      now: () => now,
      isSessionOpen: () => true,
      minRestIntervalMs: 10_000,
    });
    return { reader, innerCalls, advance: (ms: number) => { now += ms; } };
  }

  it("sends at most one REST call per ten seconds for a symbol that has no tick, however often it is asked", async () => {
    const { reader, innerCalls, advance } = floorSetup();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 700) {
      await reader.quoteSymbols(["NIFTY50"]);
      advance(700);
    }
    expect(innerCalls.length).toBeLessThanOrEqual(7);
    expect(innerCalls.length).toBeGreaterThanOrEqual(5);
  });

  it("never serves a symbol it has not fetched yet from the floor", async () => {
    const { reader, innerCalls } = floorSetup();
    await reader.quoteSymbols(["NIFTY50"]);
    await reader.quoteSymbols(["BANKNIFTY"]);
    expect(innerCalls).toEqual([["NIFTY50"], ["BANKNIFTY"]]);
  });
});
