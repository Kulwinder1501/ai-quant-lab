import { describe, expect, it, vi } from "vitest";
import type { Tick } from "./fyers-live-streamer.js";
import { LiveQuoteCache } from "./live-quote-cache.js";
import { liveBookOnDemand } from "./on-demand-live-book.js";

const SYMBOL = "NSE:BANKNIFTY26OCT57100CE";

function tick(overrides: Partial<Tick> = {}): Tick {
  return { symbol: SYMBOL, ltp: 68, bid: 67.8, ask: 68.4, volume: 1_000, exchangeFeedTimeSeconds: null, lastTradeTimeSeconds: null, ...overrides };
}

function setup() {
  let now = 1_000_000;
  const cache = new LiveQuoteCache();
  const subscribe = vi.fn();
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const deps = { cache, subscriber: { subscribe }, now: () => now, sleep };
  return { deps, cache, subscribe, sleep, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("liveBookOnDemand", () => {
  it("returns a book already on the socket without subscribing or waiting", async () => {
    const { deps, cache, subscribe, sleep, at } = setup();
    cache.record(tick(), at());

    const book = await liveBookOnDemand(deps, SYMBOL, { maxAgeMs: 10_000 });
    expect(book?.ask).toBe(68.4);
    expect(subscribe).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("subscribes the contract and returns its book as soon as the first tick arrives", async () => {
    const { deps, cache, subscribe, advance, at } = setup();
    let waits = 0;
    const sleep = async (ms: number) => {
      advance(ms);
      waits += 1;
      // the tick lands during the second wait
      if (waits === 2) cache.record(tick(), at());
    };

    const book = await liveBookOnDemand({ ...deps, sleep }, SYMBOL, { maxAgeMs: 10_000, timeoutMs: 3_000, pollMs: 100 });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith([SYMBOL]);
    expect(book?.bid).toBe(67.8);
    expect(waits).toBe(2);
  });

  it("gives up after the timeout, so a contract that never quotes is refused rather than guessed", async () => {
    const { deps, subscribe, sleep } = setup();

    const book = await liveBookOnDemand(deps, SYMBOL, { maxAgeMs: 10_000, timeoutMs: 1_000, pollMs: 100 });
    expect(book).toBeNull();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it("does not take a one-sided tick for a book", async () => {
    const { deps, cache, sleep, advance, at } = setup();
    // The fake clock has to move with each wait, or the loop never reaches its deadline.
    sleep.mockImplementation(async (ms: number) => { advance(ms); cache.record(tick({ bid: null }), at()); });

    expect(await liveBookOnDemand(deps, SYMBOL, { maxAgeMs: 10_000, timeoutMs: 500, pollMs: 100 })).toBeNull();
  });

  it("does not wait when there is no socket", async () => {
    const { deps, sleep } = setup();
    expect(await liveBookOnDemand({ ...deps, subscriber: null }, SYMBOL, { maxAgeMs: 10_000 })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns null if the socket refuses the subscription", async () => {
    const { deps, subscribe, sleep } = setup();
    subscribe.mockImplementation(() => { throw new Error("socket down"); });
    expect(await liveBookOnDemand(deps, SYMBOL, { maxAgeMs: 10_000 })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });
});
