import { describe, expect, it, vi } from "vitest";
import { FyersLiveMarketDataProvider } from "./fyers-live-market-data-provider.js";
import type { FyersTokenService } from "./fyers-token-service.js";

/**
 * Shapes here are copied from the live endpoint, probed 2026-08-07 07:05 UTC:
 *
 *   NSE:SBIN-EQ          lp 1087.9    volume 7487324  tt "1786060800"
 *   NSE:NIFTYBANK-INDEX  lp 57789.3   volume 0        tt "1786060800"
 *
 * Both `tt` values decode to 2026-08-07T00:00:00Z -- mid-session, for a stock that had
 * traded 7.4m shares. See the note on EXCHANGE_TIMESTAMP_UNAVAILABLE.
 */

function tokenService(accessToken = "access-token"): FyersTokenService {
  return { getAccessToken: vi.fn(async () => accessToken) } as unknown as FyersTokenService;
}

function payload(rows: unknown[]): Response {
  return new Response(JSON.stringify({ s: "ok", code: 200, message: "", d: rows }));
}

const SBIN = {
  n: "NSE:SBIN-EQ",
  s: "ok",
  v: { lp: 1087.9, volume: 7487324, tt: "1786060800" },
};

describe("FyersLiveMarketDataProvider", () => {
  it("reads the quotes endpoint and maps a live equity row", async () => {
    let requestedUrl = "";
    let authorization: string | null = null;
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization");
        return payload([SBIN]);
      },
    });

    await expect(provider.fetchQuotes(["NSE:SBIN-EQ"])).resolves.toEqual([
      expect.objectContaining({
        providerInstrumentId: "NSE:SBIN-EQ",
        lastPrice: "1087.9",
        cumulativeVolume: "7487324",
        exchangeTimestamp: null,
      }),
    ]);
    expect(requestedUrl).toContain("/data/quotes");
    expect(requestedUrl).toContain("symbols=NSE%3ASBIN-EQ");
    expect(authorization).toBe("APP-100:access-token");
  });

  it("leaves the exchange timestamp null even though the payload carries one", async () => {
    // `tt` is the session date at UTC midnight, not a trade time. Feeding it to
    // CollectLiveMarketData would place every quote at 05:30 IST -- outside the session --
    // and every quote would be discarded, which reads as a quiet market, not as a fault.
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => payload([SBIN]),
    });

    const [quote] = await provider.fetchQuotes(["NSE:SBIN-EQ"]);

    expect(quote!.exchangeTimestamp).toBeNull();
    expect(quote!.observedAt.getTime()).toBeGreaterThan(0);
  });

  it("reports an absent volume as absent, not as zero traded", async () => {
    // The collector treats any value, "0" included, as a real cumulative baseline to
    // subtract from. Defaulting a missing volume to "0" means the next quote that does
    // carry one yields a delta of the whole session's volume, in one bar.
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => payload([{ n: "NSE:SBIN-EQ", s: "ok", v: { lp: 1087.9 } }]),
    });

    const [quote] = await provider.fetchQuotes(["NSE:SBIN-EQ"]);

    expect(quote!.cumulativeVolume).toBeNull();
  });

  it("passes a reported zero volume through, because zero is what an index reports", async () => {
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => payload([{ n: "NSE:NIFTYBANK-INDEX", s: "ok", v: { lp: 57789.3, volume: 0 } }]),
    });

    const [quote] = await provider.fetchQuotes(["NSE:NIFTYBANK-INDEX"]);

    expect(quote!.cumulativeVolume).toBe("0");
  });

  it("skips a row the provider marked not-ok, and one it did not ask for", async () => {
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => payload([
        { n: "NSE:SBIN-EQ", s: "error", v: { lp: 1087.9 } },
        { n: "NSE:UNREQUESTED-EQ", s: "ok", v: { lp: 10 } },
        SBIN,
      ]),
    });

    const quotes = await provider.fetchQuotes(["NSE:SBIN-EQ", "NSE:RELIANCE-EQ"]);

    expect(quotes.map((quote) => quote.providerInstrumentId)).toEqual(["NSE:SBIN-EQ"]);
  });

  it("skips an unusable price instead of failing the whole batch", async () => {
    // CollectLiveMarketData throws on a non-positive price, so one bad symbol would abort
    // the poll for every other instrument in it.
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => payload([
        { n: "NSE:ZERO-EQ", s: "ok", v: { lp: 0, volume: 10 } },
        { n: "NSE:NEGATIVE-EQ", s: "ok", v: { lp: -5, volume: 10 } },
        { n: "NSE:MISSING-EQ", s: "ok", v: { volume: 10 } },
        SBIN,
      ]),
    });

    const quotes = await provider.fetchQuotes([
      "NSE:ZERO-EQ", "NSE:NEGATIVE-EQ", "NSE:MISSING-EQ", "NSE:SBIN-EQ",
    ]);

    expect(quotes.map((quote) => quote.providerInstrumentId)).toEqual(["NSE:SBIN-EQ"]);
  });

  it("splits a request above the endpoint's symbol limit and refreshes the token once", async () => {
    const symbols = Array.from({ length: 120 }, (_, index) => `NSE:SYM${index}-EQ`);
    const batches: string[][] = [];
    const service = tokenService();
    const provider = new FyersLiveMarketDataProvider({
      tokenService: service,
      appId: "APP-100",
      fetch: async (input) => {
        const requested = new URL(String(input)).searchParams.get("symbols") ?? "";
        batches.push(requested.split(","));
        return payload(requested.split(",").map((symbol) => ({ n: symbol, s: "ok", v: { lp: 1, volume: 1 } })));
      },
    });

    const quotes = await provider.fetchQuotes(symbols);

    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(quotes).toHaveLength(120);
    // One token for the whole poll: getAccessToken takes a row lock and can spend a
    // refresh against the provider, so once per batch would be three of those a tick.
    expect(service.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates and drops blank symbols before requesting", async () => {
    const batches: string[] = [];
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async (input) => {
        batches.push(new URL(String(input)).searchParams.get("symbols") ?? "");
        return payload([]);
      },
    });

    await provider.fetchQuotes(["NSE:SBIN-EQ", "NSE:SBIN-EQ", "  ", ""]);

    expect(batches).toEqual(["NSE:SBIN-EQ"]);
  });

  it("fails loudly when the provider refuses", async () => {
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: -16, message: "Token expired" }),
        { status: 401 },
      ),
    });

    await expect(provider.fetchQuotes(["NSE:SBIN-EQ"])).rejects.toThrow("HTTP 401");
  });

  it("fails on a body that is not JSON rather than reporting no quotes", async () => {
    // A silent empty result here is indistinguishable from a closed market.
    const provider = new FyersLiveMarketDataProvider({
      tokenService: tokenService(),
      appId: "APP-100",
      fetch: async () => new Response("<html>gateway timeout</html>", { status: 200 }),
    });

    await expect(provider.fetchQuotes(["NSE:SBIN-EQ"])).rejects.toThrow(/Fyers quote request failed/);
  });

  it("refuses to be constructed without an app id", () => {
    expect(() => new FyersLiveMarketDataProvider({ tokenService: tokenService(), appId: "  " }))
      .toThrow("requires an app ID");
  });
});
