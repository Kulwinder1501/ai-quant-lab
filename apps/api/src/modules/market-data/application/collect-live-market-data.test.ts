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
    const collector = new CollectLiveMarketData(
      provider, candles.repository, new NseMarketSession(),
      // Observing from the session open, so both windows below are fully watched.
      new Date("2026-07-24T03:45:00Z"),
    );
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

  it("never starts a window that opened before it did", async () => {
    // A collector that starts mid-window cannot have seen the whole of it. Measured
    // 2026-08-07: one started at 08:12 sealed the 08:00-08:15 NIFTY50 bar from three minutes
    // of quotes, range 0.9 points, marked complete. The strategies and the indicator engine
    // read it, and a later historical fetch would have skipped it as already present.
    const provider: LiveMarketDataProvider = {
      id: "test-live",
      fetchQuotes: async () => [{
        providerInstrumentId: "NSE:RELIANCE", lastPrice: "100", cumulativeVolume: "1000",
        observedAt: new Date("2026-07-24T04:12:00Z"), exchangeTimestamp: null,
      }],
    };
    const candles = candleRepository();
    const collector = new CollectLiveMarketData(
      provider, candles.repository, new NseMarketSession(),
      new Date("2026-07-24T04:12:00Z"),
    );

    const result = await collector.execute({
      subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }],
      timeframe: "15m",
      ingestionId: "live-ingestion",
      now: new Date("2026-07-24T04:12:05Z"),
    });

    // The 04:00-04:15 window opened twelve minutes before observation began.
    expect(result).toMatchObject({ quotesReceived: 1, quotesApplied: 0 });
    expect([...candles.saved.values()]).toHaveLength(0);
  });

  it("starts the next window once it begins cleanly", async () => {
    const provider: LiveMarketDataProvider = {
      id: "test-live",
      fetchQuotes: async () => [{
        providerInstrumentId: "NSE:RELIANCE", lastPrice: "100", cumulativeVolume: "1000",
        observedAt: new Date("2026-07-24T04:16:00Z"), exchangeTimestamp: null,
      }],
    };
    const candles = candleRepository();
    const collector = new CollectLiveMarketData(
      provider, candles.repository, new NseMarketSession(),
      new Date("2026-07-24T04:12:00Z"),
    );

    const result = await collector.execute({
      subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }],
      timeframe: "15m",
      ingestionId: "live-ingestion",
      now: new Date("2026-07-24T04:16:05Z"),
    });

    expect(result).toMatchObject({ quotesApplied: 1 });
    expect([...candles.saved.values()][0]).toMatchObject({ isComplete: false });
  });

  it("tracks each timeframe independently when one process collects several", async () => {
    const quote = (observedAt: string, price: string, volume: string): LiveMarketQuote => ({
      providerInstrumentId: "NSE:RELIANCE",
      lastPrice: price,
      cumulativeVolume: volume,
      observedAt: new Date(observedAt),
      exchangeTimestamp: null,
    });
    // The CLI invokes the same collector once per timeframe on every poll. Each pair below is
    // the 1m and 5m view of one provider snapshot.
    const quotes = [
      quote("2026-07-24T03:45:10Z", "100", "1000"),
      quote("2026-07-24T03:45:10Z", "100", "1000"),
      quote("2026-07-24T03:46:10Z", "101", "1010"),
      quote("2026-07-24T03:46:10Z", "101", "1010"),
      quote("2026-07-24T03:50:10Z", "102", "1050"),
      quote("2026-07-24T03:50:10Z", "102", "1050"),
    ];
    const provider: LiveMarketDataProvider = {
      id: "test-live",
      fetchQuotes: async () => {
        const next = quotes.shift();
        return next ? [next] : [];
      },
    };
    const candles = candleRepository();
    const collector = new CollectLiveMarketData(
      provider,
      candles.repository,
      new NseMarketSession(),
      new Date("2026-07-24T03:45:00Z"),
    );
    const executePair = async (now: string) => {
      for (const timeframe of ["1m", "5m"] as const) {
        await collector.execute({
          subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }],
          timeframe,
          ingestionId: "live-ingestion",
          now: new Date(now),
        });
      }
    };

    await executePair("2026-07-24T03:45:15Z");
    await executePair("2026-07-24T03:46:15Z");
    await executePair("2026-07-24T03:50:15Z");

    const values = [...candles.saved.values()];
    expect(values.some((candle) => candle.timeframe === "1m" && candle.isComplete)).toBe(true);
    expect(values.some((candle) => candle.timeframe === "5m" && candle.isComplete)).toBe(true);
    expect(values.some((candle) => candle.timeframe === "5m" && !candle.isComplete)).toBe(true);
  });

  it("leaves an earlier run's unfinished bar incomplete rather than sealing a guess", async () => {
    // Sealing it would make a partial permanent, and `skipExisting` skips only completed
    // candles -- so left incomplete, the historical fetch corrects it.
    const candles = candleRepository();
    await candles.repository.upsert({
      instrumentId: instrument.id, ingestionId: "older-run", timeframe: "15m",
      openTime: new Date("2026-07-24T03:45:00Z"), closeTime: new Date("2026-07-24T04:00:00Z"),
      open: "100", high: "100", low: "100", close: "100", volume: "0",
      isComplete: false, source: "test-live", sourceMetadata: { quoteObservedAt: "2026-07-24T03:59:00Z" },
    });
    const provider: LiveMarketDataProvider = { id: "test-live", fetchQuotes: async () => [] };
    const collector = new CollectLiveMarketData(
      provider, candles.repository, new NseMarketSession(),
      new Date("2026-07-24T04:12:00Z"),
    );

    const result = await collector.execute({
      subscriptions: [{ instrument, providerInstrumentId: "NSE:RELIANCE" }],
      timeframe: "15m",
      ingestionId: "live-ingestion",
      now: new Date("2026-07-24T04:16:05Z"),
    });

    expect(result.candlesFinalized).toBe(0);
    expect([...candles.saved.values()][0]).toMatchObject({ isComplete: false });
  });
});
