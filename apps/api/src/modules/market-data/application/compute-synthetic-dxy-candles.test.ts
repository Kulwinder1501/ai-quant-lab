import { describe, expect, it } from "vitest";
import type { CandleRepository } from "../domain/candle.js";
import { computeSyntheticDxyCandles } from "./compute-synthetic-dxy-candles.js";

const COMPONENTS = ["EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"];
const RATE: Record<string, number> = {
  EUR_USD: 1.08, USD_JPY: 150, GBP_USD: 1.27, USD_CAD: 1.36, USD_SEK: 10.6, USD_CHF: 0.88,
};
const START = new Date("2026-10-12T03:00:00.000Z").getTime();
const MINUTES = 15;

function fakeDatabase() {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("symbol = ANY")) {
        return { rows: COMPONENTS.map((symbol) => ({ symbol, id: `id-${symbol}` })) };
      }
      if (text.includes("symbol = 'DXY'")) return { rows: [{ id: "id-DXY" }] };
      const symbol = String(params?.[0]).replace("id-", "");
      const rate = RATE[symbol]!;
      return {
        rows: Array.from({ length: MINUTES }, (_, minute) => ({
          open_time: new Date(START + minute * 60_000),
          close_time: new Date(START + (minute + 1) * 60_000),
          open: String(rate), high: String(rate * 1.0001), low: String(rate * 0.9999), close: String(rate),
        })),
      };
    },
  };
}

describe("computeSyntheticDxyCandles", () => {
  it("writes every DXY candle under the 'synthetic' source the series provenance declares", async () => {
    const written: Array<{ source: string; timeframe: string; instrumentId: string }> = [];
    const repository = {
      upsert: async (candle: { source: string; timeframe: string; instrumentId: string }) => { written.push(candle); },
    } as unknown as CandleRepository;

    const result = await computeSyntheticDxyCandles(
      fakeDatabase() as never, repository, new Date(START), new Date(START + MINUTES * 60_000),
    );

    expect(result).toMatchObject({ oneMinuteBarsWritten: MINUTES, fiveMinuteBarsWritten: 3, fifteenMinuteBarsWritten: 1 });
    expect(written).toHaveLength(MINUTES + 3 + 1);
    // candles.(instrument_id, timeframe, source) is a foreign key into candle_series_provenance, which
    // declares DXY's intraday series as 'synthetic'. 'oanda' here is rejected by the database and
    // fails every XAU_CANDLE_COLLECTION run while the FX market is open.
    expect(new Set(written.map((candle) => candle.source))).toEqual(new Set(["synthetic"]));
    expect(new Set(written.map((candle) => candle.instrumentId))).toEqual(new Set(["id-DXY"]));
  });
});
