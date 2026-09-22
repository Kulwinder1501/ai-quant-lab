import { describe, expect, it, vi } from "vitest";
import { TwelveDataQuoteClient } from "./twelvedata-quote-client.js";

function okBody(close: string) {
  return new Response(JSON.stringify({
    status: "ok",
    symbol: "XAU/USD",
    name: "Gold Spot / US Dollar",
    exchange: "Forex",
    close,
    previous_close: "4300",
    change: "10.5",
    percent_change: "0.24",
    open: "4302",
    high: "4315",
    low: "4298",
    last_quote_at: 1790000000,
  }), { status: 200 });
}

function rateLimitedBody() {
  return new Response(JSON.stringify({
    status: "error",
    code: 429,
    message: "You have run out of API credits for the current minute.",
  }), { status: 429 });
}

describe("TwelveDataQuoteClient", () => {
  it("resolves the canonical symbol and maps quote fields", async () => {
    let requested: URL | null = null;
    const client = new TwelveDataQuoteClient({
      apiKey: "key-100",
      fetch: async (input) => {
        requested = new URL(String(input));
        return okBody("4310.5");
      },
    });

    const quote = await client.quoteSymbol("XAU_USD");

    expect(requested!.searchParams.get("symbol")).toBe("XAU/USD");
    expect(requested!.searchParams.get("apikey")).toBe("key-100");
    expect(quote).toMatchObject({
      symbol: "XAU_USD",
      provider: "twelvedata",
      regularMarketPrice: 4310.5,
      regularMarketPreviousClose: 4300,
      regularMarketChangePercent: 0.24,
      regularMarketVolume: null,
    });
  });

  it("does not call the network again for a repeat request inside the refresh window", async () => {
    // The reason this cache exists at all: Twelve Data's free tier is capped at 8 API
    // credits/minute, confirmed live -- a 2.5s poll loop (this codebase's standard cadence)
    // exhausted it on the 5th request, under a minute in.
    let clock = 0;
    const fetchFn = vi.fn(async () => okBody("4310.5"));
    const client = new TwelveDataQuoteClient({
      apiKey: "key-100",
      fetch: fetchFn,
      minRefreshIntervalMs: 15_000,
      now: () => clock,
    });

    await client.quoteSymbol("XAU_USD");
    clock = 5_000;
    const second = await client.quoteSymbol("XAU_USD");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second?.regularMarketPrice).toBe(4310.5);
  });

  it("refreshes again once the window has elapsed", async () => {
    let clock = 0;
    const fetchFn = vi.fn(async () => okBody("4310.5"));
    const client = new TwelveDataQuoteClient({
      apiKey: "key-100", fetch: fetchFn, minRefreshIntervalMs: 15_000, now: () => clock,
    });

    await client.quoteSymbol("XAU_USD");
    clock = 15_001;
    await client.quoteSymbol("XAU_USD");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("de-dupes concurrent callers onto one in-flight request", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const client = new TwelveDataQuoteClient({ apiKey: "key-100", fetch: fetchFn });

    const first = client.quoteSymbol("XAU_USD");
    const second = client.quoteSymbol("XAU_USD");
    resolveFetch(okBody("4310.5"));
    const [a, b] = await Promise.all([first, second]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a?.regularMarketPrice).toBe(4310.5);
    expect(b?.regularMarketPrice).toBe(4310.5);
  });

  it("serves the last good quote when a refresh is rate-limited, instead of dropping the tile", async () => {
    // Stale-but-labelled beats blank -- the same reasoning MarketWatchBroadcaster already
    // applies to its own poll failures, applied one layer lower where the actual rate limit is.
    let clock = 0;
    let fail = false;
    const client = new TwelveDataQuoteClient({
      apiKey: "key-100",
      minRefreshIntervalMs: 15_000,
      now: () => clock,
      fetch: async () => (fail ? rateLimitedBody() : okBody("4310.5")),
    });

    await client.quoteSymbol("XAU_USD");
    clock = 15_001;
    fail = true;
    const quote = await client.quoteSymbol("XAU_USD");

    expect(quote?.regularMarketPrice).toBe(4310.5);
  });

  it("returns null, not a crash, for a symbol it has never successfully fetched", async () => {
    const client = new TwelveDataQuoteClient({
      apiKey: "key-100",
      fetch: async () => rateLimitedBody(),
    });

    await expect(client.quoteSymbol("XAU_USD")).resolves.toBeNull();
  });
});
