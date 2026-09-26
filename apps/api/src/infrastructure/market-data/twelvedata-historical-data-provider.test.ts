import { describe, expect, it, vi } from "vitest";
import { TwelveDataHistoricalDataProvider } from "./twelvedata-historical-data-provider.js";

const NOW = new Date("2026-09-22T07:00:00.000Z");

function okBody(values: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>) {
  return new Response(JSON.stringify({ status: "ok", values }), { status: 200 });
}

function build(options: { fetch: typeof fetch; now?: Date; maxRetries?: number; sleep?: (ms: number) => Promise<void> }) {
  return new TwelveDataHistoricalDataProvider({
    apiKey: "test-key",
    fetch: options.fetch,
    now: () => options.now ?? NOW,
    maxRetries: options.maxRetries,
    sleep: options.sleep ?? (async () => {}),
  });
}

describe("TwelveDataHistoricalDataProvider", () => {
  it("resolves the canonical symbol, requests UTC, and derives close time from the timeframe", async () => {
    const requested: string[] = [];
    const provider = build({
      fetch: async (input) => {
        requested.push(String(input));
        return okBody([{ datetime: "2026-09-22 06:00:00", open: "4360.1", high: "4361.5", low: "4359.8", close: "4360.9" }]);
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "5m",
      from: new Date("2026-09-22T05:00:00Z"),
      to: new Date("2026-09-22T06:30:00Z"),
    });

    expect(requested[0]).toContain("symbol=XAU%2FUSD");
    expect(requested[0]).toContain("interval=5min");
    expect(requested[0]).toContain("timezone=UTC");
    expect(result).toHaveLength(1);
    expect(result[0].openTime).toEqual(new Date("2026-09-22T06:00:00Z"));
    expect(result[0].closeTime.getTime() - result[0].openTime.getTime()).toBe(5 * 60_000);
    expect(result[0]).toMatchObject({ open: "4360.1", high: "4361.5", low: "4359.8", close: "4360.9", volume: "0" });
  });

  it("defaults volume to 0 when Twelve Data omits it, rather than failing", async () => {
    const provider = build({
      fetch: async () => okBody([{ datetime: "2026-09-22 06:00:00", open: "1", high: "1", low: "1", close: "1" }]),
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-22T05:00:00Z"),
      to: new Date("2026-09-22T06:30:00Z"),
    });

    expect(result[0].volume).toBe("0");
  });

  it("rejects a timeframe Twelve Data has no native interval for, instead of resampling", async () => {
    const provider = build({ fetch: async () => okBody([]) });

    await expect(provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "3m",
      from: new Date("2026-09-22T05:00:00Z"),
      to: new Date("2026-09-22T06:00:00Z"),
    })).rejects.toThrow(/no native interval/);
  });

  it("returns nothing when the range is already fully in the future", async () => {
    const fetchFn = vi.fn(async () => okBody([]));
    const provider = build({ fetch: fetchFn });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-23T00:00:00Z"),
      to: new Date("2026-09-24T00:00:00Z"),
    });

    expect(result).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("discards a still-forming trailing bar whose close has not elapsed yet", async () => {
    const provider = build({
      fetch: async () => okBody([
        { datetime: "2026-09-22 06:58:00", open: "1", high: "1", low: "1", close: "1" }, // closes 06:59, before NOW
        { datetime: "2026-09-22 07:00:00", open: "1", high: "1", low: "1", close: "1" }, // closes 07:01, after NOW (07:00)
      ]),
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-22T06:00:00Z"),
      to: new Date("2026-09-22T07:05:00Z"),
    });

    expect(result).toHaveLength(1);
    expect(result[0].openTime).toEqual(new Date("2026-09-22T06:58:00Z"));
  });

  it("sorts results ascending even if the provider returns newest-first", async () => {
    const provider = build({
      fetch: async () => okBody([
        { datetime: "2026-09-22 06:02:00", open: "3", high: "3", low: "3", close: "3" },
        { datetime: "2026-09-22 06:00:00", open: "1", high: "1", low: "1", close: "1" },
        { datetime: "2026-09-22 06:01:00", open: "2", high: "2", low: "2", close: "2" },
      ]),
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-22T06:00:00Z"),
      to: new Date("2026-09-22T06:03:00Z"),
    });

    expect(result.map((c) => c.open)).toEqual(["1", "2", "3"]);
  });

  it("retries a 429 and succeeds once Twelve Data stops rate-limiting", async () => {
    let attempt = 0;
    const provider = build({
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) return new Response(JSON.stringify({ status: "error", code: 429, message: "limit" }), { status: 429 });
        return okBody([{ datetime: "2026-09-22 06:00:00", open: "1", high: "1", low: "1", close: "1" }]);
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-22T05:00:00Z"),
      to: new Date("2026-09-22T06:30:00Z"),
    });

    expect(attempt).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("fails loudly, not silently, when Twelve Data returns a non-ok status", async () => {
    const provider = build({
      fetch: async () => new Response(JSON.stringify({ status: "error", code: 400, message: "bad symbol" }), { status: 400 }),
      maxRetries: 0,
    });

    await expect(provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date("2026-09-22T05:00:00Z"),
      to: new Date("2026-09-22T06:30:00Z"),
    })).rejects.toThrow(/bad symbol/);
  });
});
