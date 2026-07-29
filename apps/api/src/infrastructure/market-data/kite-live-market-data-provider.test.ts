import { describe, expect, it } from "vitest";
import { KiteLiveMarketDataProvider } from "./kite-live-market-data-provider.js";

describe("KiteLiveMarketDataProvider", () => {
  it("uses the read-only quote endpoint and maps snapshot fields", async () => {
    let requestedUrl = "";
    const provider = new KiteLiveMarketDataProvider({
      apiKey: "key",
      accessToken: "token",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          status: "success",
          data: {
            "NSE:INFY": {
              last_price: 1500.25,
              volume: 12345,
              timestamp: "2026-07-25T10:00:00+0530",
            },
          },
        }));
      },
    });

    await expect(provider.fetchQuotes(["NSE:INFY", "NSE:MISSING"])).resolves.toEqual([
      expect.objectContaining({
        providerInstrumentId: "NSE:INFY",
        lastPrice: "1500.25",
        cumulativeVolume: "12345",
        exchangeTimestamp: new Date("2026-07-25T04:30:00Z"),
      }),
    ]);
    expect(requestedUrl).toContain("/quote?");
    expect(requestedUrl).toContain("i=NSE%3AINFY");
  });
});
