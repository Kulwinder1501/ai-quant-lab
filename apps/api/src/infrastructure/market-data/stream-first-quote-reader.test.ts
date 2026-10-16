import { describe, expect, it, vi } from "vitest";
import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { StreamFirstQuoteReader, overlayTick, type StreamTickSource } from "./stream-first-quote-reader.js";

function quote(symbol: string, price: number, overrides: Partial<MarketQuote> = {}): MarketQuote {
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
    regularMarketTime: new Date("2026-10-16T05:00:00Z"),
    ...overrides,
  };
}

function setup(options: { tickPrice?: number | null; baseMaxAgeMs?: number } = {}) {
  let now = 1_000_000;
  const tickBox = { price: options.tickPrice ?? null as number | null, observedAt: new Date(now) };
  const ticks: StreamTickSource = {
    lastPrice: (_symbol, maxAgeMs, at = now) =>
      tickBox.price === null || at - tickBox.observedAt.getTime() > maxAgeMs ? null : { price: tickBox.price, observedAt: tickBox.observedAt },
  };
  const innerCalls: string[][] = [];
  const inner: MarketQuoteReader = {
    quoteSymbol: async (symbol) => (await inner.quoteSymbols([symbol])).get(symbol) ?? null,
    quoteSymbols: async (symbols) => {
      innerCalls.push([...symbols]);
      return new Map(symbols.map((symbol) => [symbol, quote(symbol, 22_997)]));
    },
  };
  const subscribe = vi.fn();
  const reader = new StreamFirstQuoteReader({
    inner,
    ticks,
    subscriber: { subscribe },
    now: () => now,
    ...(options.baseMaxAgeMs === undefined ? {} : { baseMaxAgeMs: options.baseMaxAgeMs }),
  });
  return {
    reader,
    innerCalls,
    subscribe,
    tick: (price: number | null) => { tickBox.price = price; tickBox.observedAt = new Date(now); },
    advance: (ms: number) => { now += ms; },
  };
}

describe("StreamFirstQuoteReader", () => {
  it("goes to REST the first time, subscribes the symbol, and keeps the quote as a base", async () => {
    const { reader, innerCalls, subscribe } = setup();

    const quotes = await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toEqual([["NIFTY50"]]);
    expect(subscribe).toHaveBeenCalledWith(["NSE:NIFTY50-INDEX"]);
    expect(quotes.get("NIFTY50")?.regularMarketPrice).toBe(22_997);
  });

  it("answers from the tick with no request once a tick and a recent base exist", async () => {
    const { reader, innerCalls, tick } = setup();
    await reader.quoteSymbols(["NIFTY50"]);

    tick(23_010);
    const quotes = await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(1);
    const live = quotes.get("NIFTY50")!;
    expect(live.regularMarketPrice).toBe(23_010);
    expect(live.regularMarketChange).toBe(23_010 - 22_623);
    expect(live.regularMarketChangePercent).toBeCloseTo(((23_010 - 22_623) / 22_623) * 100, 8);
    // The REST-only fields carry over from the base.
    expect(live.regularMarketOpen).toBe(22_671);
    expect(live.regularMarketVolume).toBe(1_000);
  });

  it("extends the day's high and low when the tick goes past them", async () => {
    const { reader, tick } = setup();
    await reader.quoteSymbols(["NIFTY50"]);

    tick(23_100);
    expect((await reader.quoteSymbols(["NIFTY50"])).get("NIFTY50")?.regularMarketDayHigh).toBe(23_100);
    tick(22_500);
    expect((await reader.quoteSymbols(["NIFTY50"])).get("NIFTY50")?.regularMarketDayLow).toBe(22_500);
  });

  it("goes back to REST when the tick has gone quiet", async () => {
    const { reader, innerCalls, tick, advance } = setup();
    await reader.quoteSymbols(["NIFTY50"]);
    tick(23_010);
    advance(11_000);

    await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(2);
  });

  it("refreshes the base from REST once it is older than its limit, so previous close and volume do not go stale", async () => {
    const { reader, innerCalls, tick, advance } = setup({ baseMaxAgeMs: 60_000 });
    await reader.quoteSymbols(["NIFTY50"]);
    advance(61_000);
    tick(23_010);

    await reader.quoteSymbols(["NIFTY50"]);
    expect(innerCalls).toHaveLength(2);
  });

  it("sends one request for the whole set when any symbol cannot be answered from the socket", async () => {
    const { reader, innerCalls, tick } = setup();
    await reader.quoteSymbols(["NIFTY50"]);
    tick(23_010);

    const quotes = await reader.quoteSymbols(["NIFTY50", "BANKNIFTY"]);
    expect(innerCalls).toEqual([["NIFTY50"], ["NIFTY50", "BANKNIFTY"]]);
    expect(quotes.size).toBe(2);
  });

  it("subscribes each symbol once, not on every call", async () => {
    const { reader, subscribe, advance } = setup();
    await reader.quoteSymbols(["NIFTY50"]);
    advance(1_000);
    await reader.quoteSymbols(["NIFTY50"]);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("still answers from REST if the socket refuses a subscription", async () => {
    const { reader, subscribe, innerCalls } = setup();
    subscribe.mockImplementation(() => { throw new Error("socket down"); });

    const quotes = await reader.quoteSymbols(["NIFTY50"]);
    expect(quotes.get("NIFTY50")?.regularMarketPrice).toBe(22_997);
    expect(innerCalls).toHaveLength(1);
  });

  it("works without a subscriber", async () => {
    const reader = new StreamFirstQuoteReader({
      inner: { quoteSymbol: async () => null, quoteSymbols: async (s) => new Map(s.map((x) => [x, quote(x, 22_997)])) },
      ticks: { lastPrice: () => null },
    });
    expect((await reader.quoteSymbols(["NIFTY50"])).size).toBe(1);
  });
});

describe("overlayTick", () => {
  it("keeps the base's change when there is no previous close to measure against", () => {
    const base = quote("NIFTY50", 22_997, { regularMarketPreviousClose: null, regularMarketChange: 12, regularMarketChangePercent: 0.05 });
    const live = overlayTick(base, 23_000, new Date("2026-10-16T05:01:00Z"));
    expect(live.regularMarketPrice).toBe(23_000);
    expect(live.regularMarketChange).toBe(12);
  });
});
