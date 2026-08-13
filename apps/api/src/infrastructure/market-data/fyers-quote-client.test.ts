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
});
