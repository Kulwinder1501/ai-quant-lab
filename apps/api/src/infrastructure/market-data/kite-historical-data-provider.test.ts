import { describe, expect, it } from "vitest";
import { KiteHistoricalDataProvider } from "./kite-historical-data-provider.js";

describe("KiteHistoricalDataProvider", () => {
  it("uses only the historical-candle endpoint and maps daily candles", async () => {
    const requestedUrls: string[] = [];
    const provider = new KiteHistoricalDataProvider({
      apiKey: "key",
      accessToken: "token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({
          status: "success",
          data: { candles: [["2025-01-02T00:00:00+0530", 100, 110, 95, 105, 1234]] },
        }), { status: 200 });
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "256265",
      timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-01-03T00:00:00Z"),
    });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/instruments/historical/256265/day");
    expect(result[0]).toMatchObject({
      openTime: new Date("2025-01-02T03:45:00Z"),
      closeTime: new Date("2025-01-02T10:00:00Z"),
      volume: "1234",
    });
  });

  it("splits a request into per-interval windows, because the cap depends on the interval", async () => {
    const requestedUrls: string[] = [];
    const provider = new KiteHistoricalDataProvider({
      apiKey: "key",
      accessToken: "token",
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ status: "success", data: { candles: [] } }), { status: 200 });
      },
    });

    const oneYear = {
      providerInstrumentId: "256265",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-12-31T00:00:00Z"),
    };

    await provider.fetchCandles({ ...oneYear, timeframe: "1d" });
    expect(requestedUrls).toHaveLength(1);

    requestedUrls.length = 0;
    await provider.fetchCandles({ ...oneYear, timeframe: "1m" });
    expect(requestedUrls.length).toBeGreaterThan(1);
    expect(requestedUrls.every((url) => url.includes("/minute"))).toBe(true);

    requestedUrls.length = 0;
    await provider.fetchCandles({ ...oneYear, timeframe: "15m" });
    const minuteWindows = 6;
    expect(requestedUrls.length).toBeLessThan(minuteWindows);
  });

  it("still honours an explicit window override for every interval", async () => {
    const requestedUrls: string[] = [];
    const provider = new KiteHistoricalDataProvider({
      apiKey: "key",
      accessToken: "token",
      maxDaysPerRequest: 10,
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ status: "success", data: { candles: [] } }), { status: 200 });
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "256265",
      timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-01-31T00:00:00Z"),
    });

    expect(requestedUrls).toHaveLength(4);
  });
});
