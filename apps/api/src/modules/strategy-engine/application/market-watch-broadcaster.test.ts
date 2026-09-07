import { describe, expect, it, vi } from "vitest";
import { MarketWatchBroadcaster, type MarketWatchRow } from "./market-watch-broadcaster.js";
import type { MarketQuote, MarketQuoteReader } from "../../market-data/domain/market-quote.js";

const TILES = [
  { label: "NIFTY50", symbol: "NIFTY50" },
  { label: "BANKNIFTY", symbol: "BANKNIFTY" },
] as const;

function quote(price: number, changePercent: number): MarketQuote {
  return {
    symbol: "x",
    regularMarketPrice: price,
    regularMarketChangePercent: changePercent,
    observedAt: new Date("2026-08-27T04:00:00.000Z"),
  } as unknown as MarketQuote;
}

/** Reader that answers every tile and counts round-trips. */
function countingReader(): MarketQuoteReader & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    quoteSymbol: async () => null,
    quoteSymbols: async (symbols: readonly string[]) => {
      calls += 1;
      const map = new Map<string, MarketQuote>();
      for (const symbol of symbols) map.set(symbol, quote(100, 1));
      return map;
    },
  };
}

function silent() {
  return { log: () => {}, logError: () => {} };
}

describe("MarketWatchBroadcaster", () => {
  it("makes one provider call for many subscribers", async () => {
    /*
     * The reason this class exists. The interval used to live in the SSE route, so the provider was
     * polled once per 2.5s *per connected browser tab*. On 2026-08-27 that traffic -- shared with
     * the collectors and the agent -- earned an app-wide 429 with a 2374s cooldown and blanked every
     * live panel. Subscriber count must not affect provider load.
     */
    const reader = countingReader();
    const broadcaster = new MarketWatchBroadcaster({ quotes: reader, tiles: TILES, ...silent() });
    const seen: MarketWatchRow[][] = [];

    const unsubscribes = [0, 1, 2, 3].map(() => broadcaster.subscribe((rows) => seen.push([...rows])));
    await broadcaster.pollOnce();

    expect(broadcaster.stats.subscribers).toBe(4);
    // One call from the first subscribe's immediate poll, one from the explicit poll. Not per tab.
    expect(reader.calls()).toBeLessThanOrEqual(2);
    for (const release of unsubscribes) release();
    broadcaster.stop();
  });

  it("replays the cached snapshot to a late subscriber without polling again", async () => {
    // Previously every tab waited a full interval for its first frame, showing "Connecting to live
    // feed..." even when another tab already had the data in memory.
    const reader = countingReader();
    const broadcaster = new MarketWatchBroadcaster({ quotes: reader, tiles: TILES, ...silent() });
    const first = broadcaster.subscribe(() => {});
    await broadcaster.pollOnce();
    const callsBefore = reader.calls();

    const received: MarketWatchRow[][] = [];
    const second = broadcaster.subscribe((rows) => received.push([...rows]));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(reader.calls()).toBe(callsBefore);
    first();
    second();
    broadcaster.stop();
  });

  it("keeps the last good snapshot when a poll fails", async () => {
    /*
     * Stale-but-labelled beats blank. The panel cannot distinguish "no rows" from "quotes
     * unavailable", so discarding the snapshot on a transient failure would turn a 2.5s blip into an
     * apparently empty market.
     */
    let fail = false;
    const reader: MarketQuoteReader = {
      quoteSymbol: async () => null,
      quoteSymbols: async (symbols: readonly string[]) => {
        if (fail) throw new Error("HTTP 429");
        const map = new Map<string, MarketQuote>();
        for (const symbol of symbols) map.set(symbol, quote(100, 1));
        return map;
      },
    };
    const broadcaster = new MarketWatchBroadcaster({ quotes: reader, tiles: TILES, ...silent() });
    const release = broadcaster.subscribe(() => {});
    await broadcaster.pollOnce();
    expect(broadcaster.snapshot).toHaveLength(2);

    fail = true;
    await broadcaster.pollOnce();

    expect(broadcaster.snapshot).toHaveLength(2);
    expect(broadcaster.stats.consecutiveFailures).toBeGreaterThan(0);
    release();
    broadcaster.stop();
  });

  it("logs the first failure and then throttles, and reports recovery", async () => {
    // Unthrottled this writes a line every 2.5s for the whole outage. The `catch` it replaces was
    // empty, which is why a 429 took a manual provider request to find.
    const logError = vi.fn();
    const log = vi.fn();
    let clock = 0;
    let fail = true;
    const reader: MarketQuoteReader = {
      quoteSymbol: async () => null,
      quoteSymbols: async (symbols: readonly string[]) => {
        if (fail) throw new Error("HTTP 429");
        const map = new Map<string, MarketQuote>();
        for (const symbol of symbols) map.set(symbol, quote(100, 1));
        return map;
      },
    };
    const broadcaster = new MarketWatchBroadcaster({
      quotes: reader, tiles: TILES, log, logError, now: () => clock,
    });

    await broadcaster.pollOnce();
    await broadcaster.pollOnce();
    await broadcaster.pollOnce();
    expect(logError).toHaveBeenCalledTimes(1);

    clock = 31_000;
    await broadcaster.pollOnce();
    expect(logError).toHaveBeenCalledTimes(2);

    fail = false;
    await broadcaster.pollOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("recovered");
    broadcaster.stop();
  });

  it("tells every subscriber when a poll fails, so no stream sends zero bytes", async () => {
    /*
     * Regression guard. An earlier version of this refactor moved polling out of the route and lost
     * the failure notification with it, so a failing stream went back to sending nothing at all --
     * the exact state that made the original outage undiagnosable, since an open socket delivering
     * nothing is indistinguishable from a healthy connection that has not ticked yet.
     */
    const reader: MarketQuoteReader = {
      quoteSymbol: async () => null,
      quoteSymbols: async () => { throw new Error("HTTP 429"); },
    };
    const broadcaster = new MarketWatchBroadcaster({ quotes: reader, tiles: TILES, ...silent() });
    const unavailable: number[] = [];
    const rows: MarketWatchRow[][] = [];

    const release = broadcaster.subscribe(
      (received) => rows.push([...received]),
      (failures) => unavailable.push(failures),
    );
    await broadcaster.pollOnce();

    expect(rows).toHaveLength(0);
    expect(unavailable.length).toBeGreaterThan(0);
    // Counts up, so a transport can report how long it has been dark.
    expect(unavailable[unavailable.length - 1]).toBeGreaterThanOrEqual(1);
    release();
    broadcaster.stop();
  });

  it("stops polling once the last subscriber leaves, and tolerates double release", async () => {
    /*
     * A shared poller outlives any one request, so unlike the per-connection interval it must be
     * shut down explicitly or it keeps spending the quote budget with nobody watching. Release is
     * idempotent because a stream can both close and error, and double-removal would otherwise
     * decrement past the real count and stop a loop others still need.
     */
    const reader = countingReader();
    const broadcaster = new MarketWatchBroadcaster({ quotes: reader, tiles: TILES, ...silent() });

    const a = broadcaster.subscribe(() => {});
    const b = broadcaster.subscribe(() => {});
    expect(broadcaster.stats.subscribers).toBe(2);

    a();
    a();
    expect(broadcaster.stats.subscribers).toBe(1);

    b();
    expect(broadcaster.stats.subscribers).toBe(0);

    const callsAfterIdle = reader.calls();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls()).toBe(callsAfterIdle);
  });
});
