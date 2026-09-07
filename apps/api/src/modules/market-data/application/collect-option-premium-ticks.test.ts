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
    const fetchFn = vi.fn(async (request: URL | RequestInfo) => {
      expect(String(request)).toContain("NSE%3ANIFTY50-INDEX");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          s: "ok",
          d: [
            { n: "NSE:NIFTY50-INDEX", s: "ok", v: { lp: 22_123.45 } },
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
    expect(stored.every((tick) => tick.underlyingValue === 22_123.45)).toBe(true);
  });
});
