import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { LiveQuoteCache } from "./live-quote-cache.js";
import type { Tick } from "./fyers-live-streamer.js";

const SYMBOL = "NSE:BANKNIFTY26OCT55300CE";
const T0 = 1_000_000;

function tick(overrides: Partial<Tick> = {}): Tick {
  return {
    symbol: SYMBOL, ltp: 645, bid: 644.5, ask: 646, volume: 1000,
    exchangeFeedTimeSeconds: null, lastTradeTimeSeconds: null,
    ...overrides,
  };
}

describe("LiveQuoteCache", () => {
  it("returns the latest two-sided quote for a symbol", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick(), T0);
    expect(cache.quote(SYMBOL, 10_000, T0 + 2_000)).toEqual({ bid: 644.5, ask: 646, ltp: 645, observedAt: new Date(T0) });
  });

  it("knows nothing about a symbol it has never heard", () => {
    expect(new LiveQuoteCache().quote(SYMBOL, 10_000, T0)).toBeNull();
  });

  it("refuses a quote older than the limit", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick(), T0);
    expect(cache.quote(SYMBOL, 10_000, T0 + 10_000)).not.toBeNull();
    expect(cache.quote(SYMBOL, 10_000, T0 + 10_001)).toBeNull();
  });

  it("does not refresh a side the tick did not carry, and judges the quote by its older side", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick({ bid: 644.5, ask: 646 }), T0);
    // 8 s later only the ask updates: the bid is still the 8-second-old one.
    cache.record(tick({ bid: null, ask: 647, ltp: 646.5 }), T0 + 8_000);
    expect(cache.quote(SYMBOL, 10_000, T0 + 9_000)).toMatchObject({ bid: 644.5, ask: 647, observedAt: new Date(T0) });
    // By 11 s the untouched bid has aged out, so the whole quote is refused.
    expect(cache.quote(SYMBOL, 10_000, T0 + 11_000)).toBeNull();
  });

  it("refuses a one-sided book, and a crossed one", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick({ bid: null, ask: 646 }), T0);
    expect(cache.quote(SYMBOL, 10_000, T0)).toBeNull();
    cache.record(tick({ bid: 650, ask: 646 }), T0);
    expect(cache.quote(SYMBOL, 10_000, T0)).toBeNull();
  });

  it("keeps symbols apart", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick(), T0);
    cache.record(tick({ symbol: "NSE:BANKNIFTY26OCT55400CE", bid: 600, ask: 601, ltp: 600.5 }), T0);
    expect(cache.quote(SYMBOL, 10_000, T0)?.ask).toBe(646);
    expect(cache.quote("NSE:BANKNIFTY26OCT55400CE", 10_000, T0)?.ask).toBe(601);
  });

  it("serves an index's last price, which has no bid or ask", () => {
    const cache = new LiveQuoteCache();
    cache.record(tick({ symbol: "NSE:BANKNIFTY-INDEX", ltp: 55125.4, bid: null, ask: null }), T0);
    expect(cache.lastPrice("NSE:BANKNIFTY-INDEX", 10_000, T0 + 3_000)).toEqual({ price: 55125.4, observedAt: new Date(T0) });
    expect(cache.lastPrice("NSE:BANKNIFTY-INDEX", 10_000, T0 + 20_000)).toBeNull();
  });

  it("listens to a streamer's tick events, and stops when told to", () => {
    const cache = new LiveQuoteCache();
    const streamer = new EventEmitter();
    const stop = cache.attach(streamer);
    streamer.emit("tick", tick());
    expect(cache.quote(SYMBOL, 10_000)?.ask).toBe(646);

    stop();
    streamer.emit("tick", tick({ ask: 700 }));
    expect(cache.quote(SYMBOL, 10_000)?.ask).toBe(646);
  });
});
