import { describe, expect, it } from "vitest";
import { YahooHistoricalDataProvider } from "./yahoo-historical-data-provider.js";

const baseRequest = {
  providerInstrumentId: "NIFTY50",
  from: new Date("2026-07-01T00:00:00Z"),
  to: new Date("2026-07-02T00:00:00Z"),
};

describe("YahooHistoricalDataProvider", () => {
  // Yahoo serves no 3m or 10m interval. The provider used to fall back to 1m and 5m
  // respectively while the caller stamped each row with the coarser duration, so a
  // "3m" series was really overlapping 1m bars carrying a 1m high/low/close. Refusing
  // is the only honest answer until something aggregates the finer series properly.
  it.each(["3m", "10m"] as const)(
    "refuses %s rather than relabelling a finer Yahoo bar",
    async (timeframe) => {
      const provider = new YahooHistoricalDataProvider();
      await expect(
        provider.fetchCandles({ ...baseRequest, timeframe }),
      ).rejects.toThrow(/no native "\dm?m" interval|no native/);
    },
  );

  it("refuses an unrecognised timeframe instead of silently serving daily bars", async () => {
    const provider = new YahooHistoricalDataProvider();
    await expect(
      provider.fetchCandles({ ...baseRequest, timeframe: "4h" as never }),
    ).rejects.toThrow(/no native/);
  });

  it("reports the provider id used for candle provenance", () => {
    expect(new YahooHistoricalDataProvider().id).toBe("yahoo");
  });
});
