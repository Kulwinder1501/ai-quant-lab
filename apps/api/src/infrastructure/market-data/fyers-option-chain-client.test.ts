import { describe, expect, it, vi } from "vitest";
import { FyersOptionChainClient } from "./fyers-option-chain-client.js";

const NOW = new Date("2026-08-04T09:30:00.000Z");

function chainBody(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    s: "ok",
    code: 200,
    data: {
      expiryData: [{ date: "04-08-2026", expiry: "1785838200", expiry_flag: "W" }],
      optionsChain: [
        // The synthetic underlying row: strike 0, no option type, carries spot.
        { strike_price: 0, ltp: 24_010, symbol: "NSE:NIFTY50-INDEX" },
        {
          strike_price: 24_000, option_type: "CE", symbol: "NSE:NIFTY2680424000CE",
          fyToken: "tok-ce", ltp: 120, bid: 119, ask: 121,
          volume: 5_000, oi: 1_000, prev_oi: 900, oich: 100,
        },
        {
          strike_price: 24_000, option_type: "PE", symbol: "NSE:NIFTY2680424000PE",
          fyToken: "tok-pe", ltp: 0.05, bid: 0, ask: 0.05,
          volume: 733_555, oi: 3_630_510, prev_oi: 6_644_880, oich: -3_014_370,
        },
      ],
      ...overrides,
    },
  }), { status: 200 });
}

function build(fetchImpl: typeof fetch) {
  return new FyersOptionChainClient({
    tokenService: { getAccessToken: vi.fn(async () => "access-token") },
    appId: "APPID-100",
    fetch: fetchImpl,
    now: () => NOW,
  });
}

describe("FyersOptionChainClient", () => {
  it("maps contracts and lifts spot out of the synthetic underlying row", async () => {
    const client = build(async () => chainBody());

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    expect(snapshot.underlyingSymbol).toBe("NIFTY50");
    expect(snapshot.provider).toBe("fyers-api-v3");
    // Receipt time: the payload carries no provider or exchange clock.
    expect(snapshot.observedAt).toEqual(NOW);
    expect(snapshot.underlyingValue).toBe(24_010);
    // The strike-0 row is spot, not a contract, so it must not become a quote.
    expect(snapshot.quotes).toHaveLength(2);
  });

  it("records the provider's own W/M flag rather than inferring from the weekday", async () => {
    // NSE moved weeklies to one index and to Tuesday, so any weekday rule is stale.
    const client = build(async () => chainBody());

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    expect(snapshot.quotes.every((quote) => quote.expiryKind === "WEEKLY")).toBe(true);
    expect(snapshot.quotes[0]!.expiryDate.toISOString().slice(0, 10)).toBe("2026-08-04");
  });

  it("surfaces the whole expiry calendar, not only the expiry these quotes cover", async () => {
    // One request returns one expiry's book but the header's full calendar. That calendar is
    // the only authority on which contracts exist, and discarding it is what allowed a
    // BANKNIFTY weekly — an expiry that underlying does not carry — to be traded.
    const client = build(async () => chainBody({
      expiryData: [
        { date: "25-08-2026", expiry: "1", expiry_flag: "M" },
        { date: "04-08-2026", expiry: "2", expiry_flag: "W" },
        { date: "29-09-2026", expiry: "3", expiry_flag: "M" },
      ],
    }));

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    // Ascending, so "nearest listed" in a refusal message reads in date order.
    expect(snapshot.listedExpiries.map((entry) => [
      entry.expiryDate.toISOString(), entry.expiryKind,
    ])).toEqual([
      ["2026-08-04T10:00:00.000Z", "WEEKLY"],
      ["2026-08-25T10:00:00.000Z", "MONTHLY"],
      ["2026-09-29T10:00:00.000Z", "MONTHLY"],
    ]);
  });

  it("stamps every listed expiry at the 15:30 IST close", async () => {
    // Midnight would settle a position at 05:30 IST on expiry day, before the market opens.
    const client = build(async () => chainBody());

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    expect(snapshot.listedExpiries).toHaveLength(1);
    expect(snapshot.listedExpiries[0]!.expiryDate.toISOString()).toBe("2026-08-04T10:00:00.000Z");
  });

  // Fyers reports "nobody is quoting" as 0. A zero bid would claim someone was willing
  // to pay nothing, which would make the most illiquid strikes look the cheapest.
  it("treats a zero bid as absent, not as a price of zero", async () => {
    const client = build(async () => chainBody());

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });
    const put = snapshot.quotes.find((quote) => quote.optionType === "PE")!;

    expect(put.bid).toBeNull();
    expect(put.ask).toBe(0.05);
  });

  it("keeps a falling open-interest change signed", async () => {
    const client = build(async () => chainBody());

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });
    const put = snapshot.quotes.find((quote) => quote.optionType === "PE")!;

    expect(put.openInterestChange).toBe(-3_014_370);
    expect(put.previousOpenInterest).toBe(6_644_880);
  });

  it("resolves the canonical symbol to the provider's spelling", async () => {
    let requested = "";
    const client = build(async (input) => {
      requested = String(input);
      return chainBody();
    });

    await client.fetchChain({ underlyingSymbol: "BANKNIFTY" });

    // Futures use BANKNIFTY but the index is NIFTYBANK; the resolver owns that asymmetry.
    expect(requested).toContain("symbol=NSE%3ANIFTYBANK-INDEX");
    expect(requested).toContain("strikecount=10");
  });

  // Fyers signals failure in the body with HTTP 200, so response.ok is not a verdict.
  it("treats an error body as a failure despite a 200 status", async () => {
    const client = build(async () => new Response(
      JSON.stringify({ s: "error", code: -300, message: "invalid symbol" }),
      { status: 200 },
    ));

    await expect(client.fetchChain({ underlyingSymbol: "NOSUCH" })).rejects.toThrow(/code -300.*invalid symbol/s);
  });

  it("rejects an out-of-range strike count instead of sending it", async () => {
    const fetchSpy = vi.fn(async () => chainBody());
    const client = build(fetchSpy);

    await expect(client.fetchChain({ underlyingSymbol: "NIFTY50", strikeCount: 0 }))
      .rejects.toThrow(/between 1 and 50/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the colon-joined Fyers authorization header", async () => {
    let authorization: string | undefined;
    const client = build(async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return chainBody();
    });

    await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    expect(authorization).toBe("APPID-100:access-token");
  });
});
