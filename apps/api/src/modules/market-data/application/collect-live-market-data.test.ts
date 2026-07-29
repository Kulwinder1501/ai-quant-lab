import { describe, expect, it } from "vitest";
import { CollectLiveMarketData } from "./collect-live-market-data.js";
import type { CandleRepository, PersistedCandle, UpsertCandleInput } from "../domain/candle.js";
import type { Instrument } from "../domain/instrument.js";
import type { LiveMarketDataProvider, LiveMarketQuote } from "../domain/live-market-data-provider.js";
import { NseMarketSession } from "../domain/nse-market-session.js";

const instrument: Instrument = {
  id: "instrument-1", exchange: "NSE", symbol: "RELIANCE", displayName: "Reliance",
  instrumentType: "EQUITY", isin: null, tickSize: "0.05", lotSize: 1, isActive: true, metadata: {},
};

function candleRepository(): { repository: CandleRepository; saved: Map<string, PersistedCandle> } {
  const saved = new Map<string, PersistedCandle>();
  const keyFor = (instrumentId: string, timeframe: string, openTime: Date) => `${instrumentId}:${timeframe}:${openTime.toISOString()}`;
  return {
    saved,
    repository: {
      upsert: async (input: UpsertCandleInput) => {
        const key = keyFor(input.instrumentId, input.timeframe, input.openTime);
        const persisted: PersistedCandle = {
          id: key,
          instrumentId: input.instrumentId,
          ingestionId: input.ingestionId ?? null,
          timeframe: input.timeframe,
          openTime: input.openTime,
          closeTime: input.closeTime,
          open: input.open,
          high: input.high,
          low: input.low,
          close: input.close,
          volume: input.volume,
          isComplete: input.isComplete,
          source: input.source,
          sourceMetadata: input.sourceMetadata ?? {},
        };
        saved.set(key, persisted);
        return persisted;
      },
      findByKey: async (instrumentId, timeframe, openTime) => saved.get(keyFor(instrumentId, timeframe, openTime)) ?? null,
      listIncomplete: async (instrumentIds, timeframe, closedBefore) => [...saved.values()].filter((candle) =>
        instrumentIds.includes(candle.instrumentId)
        && candle.timeframe === timeframe
        && !candle.isComplete
        && candle.closeTime <= closedBefore),
      listCompleted: async () => [],
    },
  };
}

describe("CollectLiveMarketData", () => {
  it("creates provisional candles and seals a completed candle at the next minute boundary", async () => {
    const quotes: LiveMarketQuote[] = [
      { providerInstrumentId: "NSE:RELIANCE", lastPrice: "100", cumulativeVolume: "1000", observedAt: new Date("2026-07-24T03:45:10Z"), exchangeTimestamp: null },
      { providerInstrumentId: "NSE:RELIANCE", lastPrice: "102", cumulativeVolume: "1010", observedAt: new Date("2026-07-24T03:46:10Z"), exchangeTimestamp: null },
    ];
    const provider: LiveMarketDataProvider = {
      id: "test-live",
      fetchQuotes: async () => {
        const next = quotes.shift();
        return next ? [next] : [];
      },
    };
    const candles = candleRepository();
    const collector = new CollectLiveMarketData(provider, candles.repository, new NseMarketSession());
    const input = { subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }], timeframe: "1m" as const, ingestionId: "live-ingestion" };

    await collector.execute({ ...input, now: new Date("2026-07-24T03:45:15Z") });
    await expect(collector.execute({ ...input, now: new Date("2026-07-24T03:46:15Z") })).resolves.toMatchObject({ candlesFinalized: 1, quotesApplied: 1 });

    const values = [...candles.saved.values()].sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({ isComplete: true, open: "100", close: "100" });
    expect(values[1]).toMatchObject({ isComplete: false, open: "102", close: "102", volume: "10" });
  });

  it("does not request quotes outside the NSE weekday session", async () => {
    const provider: LiveMarketDataProvider = { id: "test-live", fetchQuotes: async () => { throw new Error("should not poll"); } };
    const candles = candleRepository();
    const collector = new CollectLiveMarketData(provider, candles.repository, new NseMarketSession());

    await expect(collector.execute({
      subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }],
      timeframe: "1m",
      ingestionId: "live-ingestion",
      now: new Date("2026-07-25T04:00:00Z"), // Saturday
    })).resolves.toMatchObject({ quotesReceived: 0, quotesApplied: 0 });
  });
});
