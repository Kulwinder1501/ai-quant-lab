import { describe, expect, it, vi } from "vitest";
import { FyersQuoteClient } from "./fyers-quote-client.js";

describe("FyersQuoteClient", () => {
  it("resolves canonical symbols, authenticates once, and maps quote fields", async () => {
    const getAccessToken = vi.fn(async () => "token");
    let requested: URL | null = null;
    let authorization: string | null = null;
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken },
      now: () => new Date("2026-08-13T06:00:00Z"),
      fetch: async (input, init) => {
        requested = new URL(String(input));
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({
          s: "ok",
          d: [{
            n: "NSE:NIFTY50-INDEX",
            s: "ok",
            v: {
              lp: 24600,
              ch: 120,
              chp: 0.49,
              open_price: 24520,
              high_price: 24640,
              low_price: 24490,
              prev_close_price: 24480,
              volume: null,
            },
          }],
        }), { status: 200 });
      },
    });

    const quotes = await client.quoteSymbols(["NIFTY50"]);

    expect(requested!.searchParams.get("symbols")).toBe("NSE:NIFTY50-INDEX");
    expect(authorization).toBe("APP-100:token");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(quotes.get("NIFTY50")).toMatchObject({
      provider: "fyers-api-v3",
      exchange: "NSE",
      regularMarketPrice: 24600,
      regularMarketChangePercent: 0.49,
      regularMarketVolume: null,
    });
  });

  it("chunks quote requests at the Fyers 50-symbol limit", async () => {
    const calls: string[] = [];
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      fetch: async (input) => {
        calls.push(new URL(String(input)).searchParams.get("symbols")!);
        return new Response(JSON.stringify({ s: "ok", d: [] }), { status: 200 });
      },
    });

    await client.quoteSymbols(Array.from({ length: 51 }, (_, index) => `TEST${index}`));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.split(",")).toHaveLength(50);
    expect(calls[1]!.split(",")).toHaveLength(1);
  });

  it("throws on a provider error instead of silently falling back", async () => {
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: -99, message: "invalid token" }),
        { status: 401 },
      ),
    });

    await expect(client.quoteSymbol("BANKNIFTY")).rejects.toThrow(/invalid token/);
  });

  it("retries on HTTP 429 and succeeds on subsequent attempt", async () => {
    let attempt = 0;
    const sleep = vi.fn(async () => {});
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      sleep,
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ s: "error", code: 429, message: "request limit reached" }), {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        return new Response(JSON.stringify({
          s: "ok",
          d: [{
            n: "NSE:NIFTY50-INDEX",
            s: "ok",
            v: { lp: 24650, prev_close_price: 24500 },
          }],
        }), { status: 200 });
      },
    });

    const quote = await client.quoteSymbol("NIFTY50");
    expect(quote?.regularMarketPrice).toBe(24650);
    expect(attempt).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("throws after exhausting max retries on persistent 429", async () => {
    const sleep = vi.fn(async () => {});
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      maxRetries: 2,
      sleep,
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: 429, message: "request limit reached" }),
        { status: 429 },
      ),
    });

    await expect(client.quoteSymbol("NIFTY50")).rejects.toThrow(/HTTP 429/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("caps a multi-minute retry-after instead of sleeping through it", async () => {
    /*
     * Measured 2026-08-27: the provider rate-limits at its Cloudflare edge and answers 429 with
     * `retry-after: 2374` -- 39.6 minutes. Honouring that literally blocked one quote call for up
     * to `maxRetries` sleeps of that length inside an HTTP handler, and because the market-watch
     * SSE poll is guarded by an in-flight flag, the sleeping call suppressed every later tick on
     * that connection. A 40-minute provider penalty became a multi-hour dead dashboard.
     *
     * The caller has to fail fast and let the next poll try, so the header is clamped.
     */
    const sleep = vi.fn(async () => {});
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      maxRetries: 1,
      sleep,
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: 429, message: "request limit reached" }),
        { status: 429, headers: { "Retry-After": "2374" } },
      ),
    });

    await expect(client.quoteSymbol("NIFTY50")).rejects.toThrow(/HTTP 429/);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(sleep).not.toHaveBeenCalledWith(2_374_000);
  });

  it("names the requested cooldown in the failure, since the caller cannot see the response", async () => {
    // Without this the thrown message read "HTTP 429, code 429. request limit reached", which does
    // not distinguish a brief overage from a 40-minute penalty -- the one thing worth knowing.
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      maxRetries: 0,
      sleep: async () => {},
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: 429, message: "request limit reached" }),
        { status: 429, headers: { "Retry-After": "2374" } },
      ),
    });

    await expect(client.quoteSymbol("NIFTY50")).rejects.toThrow(/2374s cooldown/);
  });

  it("bounds every quote round-trip with an abort signal", async () => {
    // A response that never arrives is the other way this wedges a stream poll, and nothing here
    // bounded it. Asserting the signal is passed rather than timing a real hang.
    const seen: Array<RequestInit | undefined> = [];
    const client = new FyersQuoteClient({
      appId: "APP-100",
      tokenService: { getAccessToken: async () => "token" },
      fetch: async (_url, init) => {
        seen.push(init);
        return new Response(JSON.stringify({
          s: "ok",
          d: [{ n: "NSE:NIFTY50-INDEX", s: "ok", v: { lp: 24650, prev_close_price: 24500 } }],
        }), { status: 200 });
      },
    });

    await client.quoteSymbol("NIFTY50");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
  });
});
