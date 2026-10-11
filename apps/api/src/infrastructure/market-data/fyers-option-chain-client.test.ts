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

  // Regression test for the 2026-09-29 to 2026-10-05 NIFTY50 chain gap: a weekly symbol's month
  // slot is one fixed-width character, `1`-`9` for Jan-Sep but `O`/`N`/`D` for Oct/Nov/Dec -- never
  // the two-digit `10`/`11`/`12` a plain `Number(month)` produces. With more than one expiry in the
  // header (NIFTY50 always has several, unlike BANKNIFTY's monthly-only calendar), every row
  // used to go unattributable from the first October weekly onward and the whole chain came back
  // with zero quotes.
  it("matches an October/November/December weekly symbol by its single-letter month code", async () => {
    const client = build(async () => new Response(JSON.stringify({
      s: "ok",
      code: 200,
      data: {
        // More than one expiry in the header, so the shortcut for a lone date does not apply and
        // the symbol must actually be parsed.
        expiryData: [
          { date: "06-10-2026", expiry: "1", expiry_flag: "W" },
          { date: "27-10-2026", expiry: "2", expiry_flag: "M" },
        ],
        optionsChain: [
          { strike_price: 0, ltp: 22_513, symbol: "NSE:NIFTY50-INDEX" },
          {
            strike_price: 22_000, option_type: "CE", symbol: "NSE:NIFTY26O0622000CE",
            fyToken: "tok-ce", ltp: 527, bid: 530.1, ask: 531.45, volume: 2_997_670,
            oi: 518_895, prev_oi: 775_905, oich: -257_010,
          },
          {
            strike_price: 22_000, option_type: "PE", symbol: "NSE:NIFTY26O0622000PE",
            fyToken: "tok-pe", ltp: 6.15, bid: 6.1, ask: 6.15, volume: 183_136_200,
            oi: 14_080_495, prev_oi: 10_058_500, oich: 4_021_995,
          },
        ],
      },
    }), { status: 200 }));

    const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

    expect(snapshot.quotes).toHaveLength(2);
    expect(snapshot.quotes.every((quote) => quote.expiryKind === "WEEKLY")).toBe(true);
    expect(snapshot.quotes.every((quote) => quote.expiryDate.toISOString().slice(0, 10) === "2026-10-06"))
      .toBe(true);
  });

  // Regression for the 2026-09 audit: the monthly token (`26SEP`) was tested against EVERY header
  // date in ascending order, so the 29-Sep monthly book matched the 22-Sep weekly and was stored
  // (and flagged WEEKLY) under the wrong expiry -- 51 snapshots / 3,162 NIFTY50 rows.
  describe("expiry attribution with several header expiries", () => {
    function chainWithSymbols(
      expiryData: Array<{ date: string; expiry_flag: string }>,
      symbols: string[],
    ) {
      return build(async () => new Response(JSON.stringify({
        s: "ok",
        code: 200,
        data: {
          expiryData: expiryData.map((entry, index) => ({ ...entry, expiry: String(index + 1) })),
          optionsChain: [
            { strike_price: 0, ltp: 22_600, symbol: "NSE:NIFTY50-INDEX" },
            ...symbols.map((symbol) => ({
              strike_price: 22_600,
              option_type: symbol.endsWith("CE") ? "CE" : "PE",
              symbol,
              ltp: 100, bid: 99, ask: 101, volume: 1, oi: 10, prev_oi: 9, oich: 1,
            })),
          ],
        },
      }), { status: 200 }));
    }

    const septemberHeader = [
      { date: "08-09-2026", expiry_flag: "W" },
      { date: "15-09-2026", expiry_flag: "W" },
      { date: "22-09-2026", expiry_flag: "W" },
      { date: "29-09-2026", expiry_flag: "M" },
    ];

    it("files a monthly-token symbol under the MONTHLY date, not the first date of the month", async () => {
      const client = chainWithSymbols(septemberHeader, ["NSE:NIFTY26SEP22600CE"]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes).toHaveLength(1);
      expect(snapshot.quotes[0]!.expiryDate.toISOString().slice(0, 10)).toBe("2026-09-29");
      expect(snapshot.quotes[0]!.expiryKind).toBe("MONTHLY");
    });

    it("files a weekly-token symbol under its exact WEEKLY date", async () => {
      const client = chainWithSymbols(septemberHeader, ["NSE:NIFTY2692222600CE"]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes[0]!.expiryDate.toISOString().slice(0, 10)).toBe("2026-09-22");
      expect(snapshot.quotes[0]!.expiryKind).toBe("WEEKLY");
    });

    it("keeps weekly and monthly books apart when both appear in one response", async () => {
      const client = chainWithSymbols(septemberHeader, [
        "NSE:NIFTY2692222600CE",
        "NSE:NIFTY26SEP22600CE",
        "NSE:NIFTY26SEP22600PE",
      ]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes.map((quote) => [quote.providerSymbol, quote.expiryDate.toISOString().slice(0, 10)])).toEqual([
        ["NSE:NIFTY2692222600CE", "2026-09-22"],
        ["NSE:NIFTY26SEP22600CE", "2026-09-29"],
        ["NSE:NIFTY26SEP22600PE", "2026-09-29"],
      ]);
    });

    it("resolves the October monthly token past the October weekly, and O/N/D weekly codes", async () => {
      const client = chainWithSymbols([
        { date: "06-10-2026", expiry_flag: "W" },
        { date: "13-10-2026", expiry_flag: "W" },
        { date: "27-10-2026", expiry_flag: "M" },
        { date: "03-11-2026", expiry_flag: "W" },
        { date: "24-11-2026", expiry_flag: "M" },
        { date: "01-12-2026", expiry_flag: "W" },
        { date: "29-12-2026", expiry_flag: "M" },
      ], [
        "NSE:NIFTY26OCT22600CE",
        "NSE:NIFTY26O1322600CE",
        "NSE:NIFTY26N0322600CE",
        "NSE:NIFTY26NOV22600PE",
        "NSE:NIFTY26D0122600CE",
        "NSE:NIFTY26DEC22600PE",
      ]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes.map((quote) => quote.expiryDate.toISOString().slice(0, 10))).toEqual([
        "2026-10-27", "2026-10-13", "2026-11-03", "2026-11-24", "2026-12-01", "2026-12-29",
      ]);
    });

    it("drops a weekly-style symbol that names a date the header only lists as MONTHLY, rather than guess", async () => {
      const client = chainWithSymbols(septemberHeader, [
        "NSE:NIFTY2692922600CE", // names 29-Sep with the weekly spelling; header says monthly-only
        "NSE:NIFTY26SEP22600PE",
      ]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes.map((quote) => quote.providerSymbol)).toEqual(["NSE:NIFTY26SEP22600PE"]);
    });

    it("accepts either spelling for a date listed as BOTH weekly and monthly, and records MONTHLY", async () => {
      // Last weekly == monthly. Deterministic regardless of header order: MONTHLY wins.
      for (const order of [["W", "M"], ["M", "W"]] as const) {
        const client = chainWithSymbols([
          { date: "22-09-2026", expiry_flag: "W" },
          { date: "29-09-2026", expiry_flag: order[0] },
          { date: "29-09-2026", expiry_flag: order[1] },
        ], ["NSE:NIFTY26SEP22600CE", "NSE:NIFTY2692922600PE"]);

        const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

        expect(snapshot.quotes.map((quote) => [quote.expiryDate.toISOString().slice(0, 10), quote.expiryKind]))
          .toEqual([["2026-09-29", "MONTHLY"], ["2026-09-29", "MONTHLY"]]);
      }
    });

    it("drops a monthly-token symbol when the header lists no MONTHLY date in that month", async () => {
      const client = chainWithSymbols([
        { date: "08-09-2026", expiry_flag: "W" },
        { date: "22-09-2026", expiry_flag: "W" },
      ], ["NSE:NIFTY26SEP22600CE", "NSE:NIFTY2690822600CE"]);

      const snapshot = await client.fetchChain({ underlyingSymbol: "NIFTY50" });

      expect(snapshot.quotes.map((quote) => quote.providerSymbol)).toEqual(["NSE:NIFTY2690822600CE"]);
    });
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
