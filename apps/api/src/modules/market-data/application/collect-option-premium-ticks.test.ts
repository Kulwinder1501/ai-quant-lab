import { describe, expect, it, vi } from "vitest";
import { CollectOptionPremiumTicks } from "./collect-option-premium-ticks.js";
import type { OptionPremiumTickRow } from "../../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";

describe("CollectOptionPremiumTicks", () => {
  it("stores the live Fyers underlying print observed with the option quotes", async () => {
    const now = new Date();
    const expiry = new Date("2026-08-25T10:00:00.000Z");
    const quote = {
      expiryDate: expiry,
      expiryKind: "WEEKLY" as const,
      strikePrice: 22_000,
      optionType: "CE" as const,
      providerSymbol: "NSE:NIFTY2682522000CE",
      providerToken: null,
      lastPrice: 200,
      bid: 199,
      ask: 201,
      volume: 1_000,
      openInterest: 10_000,
      previousOpenInterest: 9_000,
      openInterestChange: 1_000,
    };
    const chainRepository = {
      latestSnapshot: vi.fn(async () => ({
        underlyingSymbol: "NIFTY50",
        provider: "fyers-api-v3",
        observedAt: now,
        underlyingValue: 22_000,
        quotes: [
          quote,
          { ...quote, optionType: "PE" as const, providerSymbol: "NSE:NIFTY2682522000PE" },
          { ...quote, strikePrice: 22_050, providerSymbol: "NSE:NIFTY2682522050CE" },
          { ...quote, strikePrice: 22_050, optionType: "PE" as const, providerSymbol: "NSE:NIFTY2682522050PE" },
        ],
        listedExpiries: [{ expiryDate: expiry, expiryKind: "WEEKLY" as const }],
      })),
    };
    const stored: OptionPremiumTickRow[] = [];
    const tickRepository = {
      insertTicks: vi.fn(async (ticks: readonly OptionPremiumTickRow[]) => {
        stored.push(...ticks);
        return { inserted: ticks.length, skipped: 0 };
      }),
    };
    // The live underlying spot is fetched alone, first, so ATM can be chosen from it rather than
    // the snapshot's own (possibly 15-minute-stale) spot; the option contracts are fetched after,
    // in a second call, once that spot has picked which contracts to ask for.
    const requestedSymbolSets: string[][] = [];
    const fetchFn = vi.fn(async (request: URL | RequestInfo) => {
      const symbols = new URL(String(request)).searchParams.get("symbols")?.split(",") ?? [];
      requestedSymbolSets.push(symbols);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          s: "ok",
          d: [
            // Close to the snapshot's own spot (22,000) but distinct, so the assertion below can
            // tell the stored value came from this live quote and not the snapshot -- while still
            // rounding to the same 22,000 strike this small fixture's chain actually lists.
            { n: "NSE:NIFTY50-INDEX", s: "ok", v: { lp: 22_010 } },
            { n: "NSE:NIFTY2682522000CE", s: "ok", v: { lp: 210, bid: 209, ask: 211, volume: 2_000 } },
            { n: "NSE:NIFTY2682522000PE", s: "ok", v: { lp: 190, bid: 189, ask: 191, volume: 2_500 } },
            { n: "NSE:NIFTY2682521900PE", s: "ok", v: { lp: 120, bid: 119, ask: 121, volume: 3_000 } },
          ],
        }),
      } as Response;
    });

    const collector = new CollectOptionPremiumTicks(
      chainRepository as never,
      tickRepository as never,
      { appId: "app", tokenService: { getAccessToken: async () => "token" }, fetch: fetchFn as never },
      {
        listForUnderlying: async () => [{
          underlyingSymbol: "NIFTY50",
          expiryDate: "2026-08-25",
          strikePrice: 21_900,
          optionType: "PE",
          providerSymbol: "NSE:NIFTY2682521900PE",
        }],
      },
    );
    const result = await collector.execute({ underlyingSymbols: ["NIFTY50"], strikeBand: 0 });

    expect(result.inserted).toBe(3);
    expect(stored).toHaveLength(3);
    expect(stored.every((tick) => tick.underlyingValue === 22_010)).toBe(true);

    // The first call asks only for the live underlying spot; the second asks only for the
    // contracts that spot resolved to (never the underlying again, and never before the first
    // call has told us which contracts are actually ATM).
    expect(requestedSymbolSets).toHaveLength(2);
    expect(requestedSymbolSets[0]).toEqual(["NSE:NIFTY50-INDEX"]);
    expect(requestedSymbolSets[1]).not.toContain("NSE:NIFTY50-INDEX");
  });

  it("chooses ATM from the live underlying spot, not the chain snapshot's stale one", async () => {
    // The chain snapshot's own spot (22,000) is up to 15 minutes old; the live quote (22,050) has
    // since moved a full strike away. Before this fix, ATM was chosen from the snapshot's spot and
    // would have picked 22,000 -- the wrong, stale strike -- silently missing 22,050.
    const now = new Date();
    const expiry = new Date("2026-08-25T10:00:00.000Z");
    const quote = {
      expiryDate: expiry,
      expiryKind: "WEEKLY" as const,
      strikePrice: 22_000,
      optionType: "CE" as const,
      providerSymbol: "NSE:NIFTY2682522000CE",
      providerToken: null,
      lastPrice: 200,
      bid: 199,
      ask: 201,
      volume: 1_000,
      openInterest: 10_000,
      previousOpenInterest: 9_000,
      openInterestChange: 1_000,
    };
    const chainRepository = {
      latestSnapshot: vi.fn(async () => ({
        underlyingSymbol: "NIFTY50",
        provider: "fyers-api-v3",
        observedAt: now,
        underlyingValue: 22_000,
        quotes: [
          quote,
          { ...quote, optionType: "PE" as const, providerSymbol: "NSE:NIFTY2682522000PE" },
          { ...quote, strikePrice: 22_050, providerSymbol: "NSE:NIFTY2682522050CE" },
          { ...quote, strikePrice: 22_050, optionType: "PE" as const, providerSymbol: "NSE:NIFTY2682522050PE" },
        ],
        listedExpiries: [{ expiryDate: expiry, expiryKind: "WEEKLY" as const }],
      })),
    };
    const stored: OptionPremiumTickRow[] = [];
    const tickRepository = {
      insertTicks: vi.fn(async (ticks: readonly OptionPremiumTickRow[]) => {
        stored.push(...ticks);
        return { inserted: ticks.length, skipped: 0 };
      }),
    };
    const fetchFn = vi.fn(async (request: URL | RequestInfo) => {
      const symbols = new URL(String(request)).searchParams.get("symbols")?.split(",") ?? [];
      const isUnderlyingOnlyCall = symbols.length === 1 && symbols[0] === "NSE:NIFTY50-INDEX";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          s: "ok",
          d: isUnderlyingOnlyCall
            ? [{ n: "NSE:NIFTY50-INDEX", s: "ok", v: { lp: 22_050 } }]
            : [
              { n: "NSE:NIFTY2682522050CE", s: "ok", v: { lp: 210, bid: 209, ask: 211, volume: 2_000 } },
              { n: "NSE:NIFTY2682522050PE", s: "ok", v: { lp: 190, bid: 189, ask: 191, volume: 2_500 } },
            ],
        }),
      } as Response;
    });

    const collector = new CollectOptionPremiumTicks(
      chainRepository as never,
      tickRepository as never,
      { appId: "app", tokenService: { getAccessToken: async () => "token" }, fetch: fetchFn as never },
    );
    const result = await collector.execute({ underlyingSymbols: ["NIFTY50"], strikeBand: 0 });

    expect(result.inserted).toBe(2);
    expect(new Set(stored.map((tick) => tick.strikePrice))).toEqual(new Set([22_050]));
  });
});
