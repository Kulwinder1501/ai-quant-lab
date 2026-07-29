import { describe, expect, it } from "vitest";
import { CsvHistoricalDataProvider } from "./csv-historical-data-provider.js";

describe("CsvHistoricalDataProvider", () => {
  it("parses daily NSE-style OHLC exports and accepts missing index volume", async () => {
    const provider = new CsvHistoricalDataProvider({
      filePath: "fixture.csv",
      readFile: async () => "Date,Open,High,Low,Close\n2025-01-02,100.00,110.25,98.50,105.75\n",
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-01-03T00:00:00Z"),
    });

    expect(result).toEqual([expect.objectContaining({
      openTime: new Date("2025-01-02T03:45:00Z"),
      closeTime: new Date("2025-01-02T10:00:00Z"),
      close: "105.75",
      volume: "0",
    })]);
  });
});
