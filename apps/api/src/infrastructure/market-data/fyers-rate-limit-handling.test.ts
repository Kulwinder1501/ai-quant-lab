import { describe, expect, it, vi } from "vitest";
import { FyersRateLimitGate, FyersRateLimitedError } from "../../modules/market-data/domain/fyers-rate-limit.js";
import { FyersLiveMarketDataProvider } from "./fyers-live-market-data-provider.js";
import { FyersQuoteClient } from "./fyers-quote-client.js";
import type { FyersTokenService } from "./fyers-token-service.js";

/** The three refusals Fyers returned on 2026-10-16, as the endpoint words them. */
const DAILY = { s: "error", code: -360, message: "You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime for higher API limits." };
const PER_MINUTE = { s: "error", code: -360, message: "You've reached the Standard plan limit of 50 requests/minute. Upgrade to Prime for higher API limits." };
const PER_SECOND = { s: "error", code: -360, message: "You've reached the Standard plan limit of 5 requests/second. Upgrade to Prime for higher API limits." };

const refused = (body: object) => new Response(JSON.stringify(body), { status: 429 });
const ok = (rows: unknown[] = []) => new Response(JSON.stringify({ s: "ok", d: rows }), { status: 200 });
const NIFTY_ROW = { n: "NSE:NIFTY50-INDEX", s: "ok", v: { lp: 22997, prev_close_price: 22623 } };

function quoteClient(fetchImpl: typeof fetch, options: { gate?: FyersRateLimitGate; cacheTtlMs?: number } = {}) {
  return new FyersQuoteClient({
    appId: "APP-100",
    tokenService: { getAccessToken: async () => "token" },
    fetch: fetchImpl,
    sleep: async () => undefined,
    rateLimitGate: options.gate ?? new FyersRateLimitGate(),
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  });
}

describe("FyersQuoteClient under a rate limit", () => {
  it("does not retry the daily cap: one refused call is one request, not four", async () => {
    const fetchSpy = vi.fn(async () => refused(DAILY));
    const client = quoteClient(fetchSpy as unknown as typeof fetch);

    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry the per-minute limit either", async () => {
    const fetchSpy = vi.fn(async () => refused(PER_MINUTE));
    const client = quoteClient(fetchSpy as unknown as typeof fetch);

    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toMatchObject({ kind: "PER_MINUTE" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries the per-second limit, which clears in about a second", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => (++calls < 3 ? refused(PER_SECOND) : ok([NIFTY_ROW])));
    const client = quoteClient(fetchSpy as unknown as typeof fetch);

    const quotes = await client.quoteSymbols(["NIFTY50"]);
    expect(quotes.get("NIFTY50")?.regularMarketPrice).toBe(22997);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("fails fast for the cooldown without sending anything, then asks again once it has passed", async () => {
    let now = Date.UTC(2026, 9, 16, 5, 34);
    const gate = new FyersRateLimitGate(() => now);
    const fetchSpy = vi.fn(async () => refused(DAILY));
    const client = quoteClient(fetchSpy as unknown as typeof fetch, { gate });

    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    await expect(client.quoteSymbols(["BANKNIFTY"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 16 * 60_000;
    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the old behaviour for a 429 that names no limit: retried, and no cooldown set", async () => {
    const gate = new FyersRateLimitGate();
    const fetchSpy = vi.fn(async () => refused({ s: "error", code: 429, message: "request limit reached" }));
    const client = quoteClient(fetchSpy as unknown as typeof fetch, { gate });

    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toThrow(/HTTP 429/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(gate.state().blocked).toBe(false);
  });
});

describe("FyersQuoteClient request sharing", () => {
  it("gives concurrent identical requests one Fyers call", async () => {
    const fetchSpy = vi.fn(async () => ok([NIFTY_ROW]));
    const client = quoteClient(fetchSpy as unknown as typeof fetch, { cacheTtlMs: 2_000 });

    const [a, b, c] = await Promise.all([
      client.quoteSymbols(["NIFTY50"]),
      client.quoteSymbols(["NIFTY50"]),
      client.quoteSymbols(["NIFTY50"]),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.get("NIFTY50")?.regularMarketPrice).toBe(22997);
    expect(b.get("NIFTY50")?.regularMarketPrice).toBe(22997);
    expect(c.get("NIFTY50")?.regularMarketPrice).toBe(22997);
  });

  it("treats the same symbols in a different order as the same request", async () => {
    const fetchSpy = vi.fn(async () => ok([NIFTY_ROW]));
    const client = quoteClient(fetchSpy as unknown as typeof fetch, { cacheTtlMs: 2_000 });

    await client.quoteSymbols(["NIFTY50", "BANKNIFTY"]);
    await client.quoteSymbols(["BANKNIFTY", "NIFTY50"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks again once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => ok([NIFTY_ROW]));
      const client = quoteClient(fetchSpy as unknown as typeof fetch, { cacheTtlMs: 2_000 });

      await client.quoteSymbols(["NIFTY50"]);
      vi.advanceTimersByTime(2_500);
      await client.quoteSymbols(["NIFTY50"]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failure: the next caller asks again", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => (++calls === 1 ? new Response("{}", { status: 500 }) : ok([NIFTY_ROW])));
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      fetch: fetchSpy as unknown as typeof fetch,
      sleep: async () => undefined,
      maxRetries: 0,
      rateLimitGate: new FyersRateLimitGate(),
      cacheTtlMs: 2_000,
    });

    await expect(client.quoteSymbols(["NIFTY50"])).rejects.toThrow();
    const quotes = await client.quoteSymbols(["NIFTY50"]);
    expect(quotes.get("NIFTY50")?.regularMarketPrice).toBe(22997);
  });

  it("returns a copy, so one caller cannot change what another receives", async () => {
    const client = quoteClient((async () => ok([NIFTY_ROW])) as unknown as typeof fetch, { cacheTtlMs: 2_000 });
    const first = await client.quoteSymbols(["NIFTY50"]);
    first.clear();
    const second = await client.quoteSymbols(["NIFTY50"]);
    expect(second.get("NIFTY50")?.regularMarketPrice).toBe(22997);
  });
});

describe("FyersLiveMarketDataProvider under a rate limit", () => {
  const tokenService = { getAccessToken: vi.fn(async () => "token") } as unknown as FyersTokenService;

  it("does not retry the daily cap, and opens the shared cooldown", async () => {
    const gate = new FyersRateLimitGate();
    const fetchSpy = vi.fn(async () => refused(DAILY));
    const provider = new FyersLiveMarketDataProvider({
      tokenService,
      appId: "APP-100",
      fetch: fetchSpy as unknown as typeof fetch,
      sleep: async () => undefined,
      rateLimitGate: gate,
    });

    await expect(provider.fetchQuotes(["NSE:NIFTY50-INDEX"])).rejects.toMatchObject({ kind: "DAILY" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The cooldown now covers the next poll: nothing is sent.
    await expect(provider.fetchQuotes(["NSE:NIFTY50-INDEX"])).rejects.toBeInstanceOf(FyersRateLimitedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
