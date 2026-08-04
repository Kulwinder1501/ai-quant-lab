import { describe, expect, it } from "vitest";
import { ImportHistoricalMarketData } from "./import-historical-market-data.js";
import type { CandleRepository, PersistedCandle, UpsertCandleInput } from "../domain/candle.js";
import type { HistoricalMarketDataProvider } from "../domain/historical-data-provider.js";
import type { Instrument } from "../domain/instrument.js";
import type { MarketDataIngestion, MarketDataIngestionRepository } from "../domain/market-data-ingestion.js";

const instrument: Instrument = {
  id: "instrument-1",
  exchange: "NSE",
  symbol: "NIFTY50",
  displayName: "NIFTY 50",
  instrumentType: "INDEX",
  isin: null,
  tickSize: "0.05",
  lotSize: 1,
  isActive: true,
  metadata: {},
};

function ingestionRepository(): { repository: MarketDataIngestionRepository; completed: number[]; failures: string[] } {
  const completed: number[] = [];
  const failures: string[] = [];
  const base: MarketDataIngestion = {
    id: "ingestion-1",
    provider: "test-provider",
    mode: "HISTORICAL",
    status: "RUNNING",
    recordCount: 0,
    startedAt: new Date("2025-01-01T00:00:00Z"),
    completedAt: null,
    errorMessage: null,
  };
  return {
    completed,
    failures,
    repository: {
      start: async () => base,
      complete: async (_id, count) => {
        completed.push(count);
        return { ...base, status: "COMPLETED", recordCount: count, completedAt: new Date() };
      },
      fail: async (_id, message) => {
        failures.push(message);
        return { ...base, status: "FAILED", errorMessage: message, completedAt: new Date() };
      },
    },
  };
}

describe("ImportHistoricalMarketData", () => {
  it("stores provider candles as completed historical evidence", async () => {
    const stored: UpsertCandleInput[] = [];
    const candles: CandleRepository = {
      upsert: async (input): Promise<PersistedCandle> => {
        stored.push(input);
        return { id: "candle", ...input, ingestionId: input.ingestionId ?? null, sourceMetadata: input.sourceMetadata ?? {} };
      },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const provider: HistoricalMarketDataProvider = {
      id: "test-provider",
      fetchCandles: async () => [{
        openTime: new Date("2025-01-01T03:45:00Z"),
        closeTime: new Date("2025-01-01T10:00:00Z"),
        open: "100", high: "110", low: "95", close: "105", volume: "10",
      }],
    };
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, candles);

    await expect(service.execute({
      instrument,
      provider,
      providerInstrumentId: "256265",
      timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"),
      to: new Date("2025-01-01T23:59:59Z"),
    })).resolves.toMatchObject({ candlesFetched: 1, candlesPersisted: 1, candlesSkipped: 0 });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ instrumentId: "instrument-1", ingestionId: "ingestion-1", isComplete: true });
    expect(ingestion.completed).toEqual([1]);
  });

  it("defers an in-progress bar instead of persisting it", async () => {
    // Yahoo appends the forming session bar, often keyed at the last trade time
    // rather than the timeframe grid. Persisting it — even as provisional —
    // littered every intraday series with orphaned rows no later fetch could
    // match. The bar is deferred: the next fetch after its close delivers it
    // settled, on-grid.
    const stored: UpsertCandleInput[] = [];
    const candles: CandleRepository = {
      upsert: async (input): Promise<PersistedCandle> => {
        stored.push(input);
        return { id: "candle", ...input, ingestionId: input.ingestionId ?? null, sourceMetadata: input.sourceMetadata ?? {} };
      },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const futureClose = new Date(Date.now() + 60 * 60 * 1000);
    const provider: HistoricalMarketDataProvider = {
      id: "test-provider",
      fetchCandles: async () => [{
        openTime: new Date(futureClose.getTime() - 6.5 * 60 * 60 * 1000),
        closeTime: futureClose,
        open: "100", high: "110", low: "95", close: "105", volume: "10",
      }],
    };
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, candles);
    const openTime = new Date(futureClose.getTime() - 6.5 * 60 * 60 * 1000);

    await expect(service.execute({
      instrument,
      provider,
      providerInstrumentId: "256265",
      timeframe: "1d",
      from: new Date(openTime.getTime() - 60_000),
      to: new Date(futureClose.getTime() + 60_000),
    })).resolves.toMatchObject({ candlesFetched: 1, candlesPersisted: 0, candlesDeferred: 1 });

    expect(stored).toHaveLength(0);
    expect(ingestion.completed).toEqual([0]);
  });

  it("skips dates already stored as completed candles when skipExisting is set", async () => {
    const day1 = new Date("2025-01-01T03:45:00Z");
    const day2 = new Date("2025-01-02T03:45:00Z");
    const existingComplete: PersistedCandle = {
      id: "existing-1",
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: day1,
      closeTime: new Date("2025-01-01T10:00:00Z"),
      open: "100", high: "110", low: "95", close: "105", volume: "10",
      isComplete: true,
      source: "test-provider",
      ingestionId: "old",
      sourceMetadata: {},
    };
    const stored: UpsertCandleInput[] = [];
    const candles: CandleRepository = {
      upsert: async (input): Promise<PersistedCandle> => {
        // day1 must never reach here — a revised value would trip the immutability
        // guard, which is exactly what skipExisting exists to avoid.
        if (input.openTime.getTime() === day1.getTime()) {
          throw new Error("Completed candles are immutable; record a provider correction as a new data revision.");
        }
        stored.push(input);
        return { id: "candle-new", ...input, ingestionId: input.ingestionId ?? null, sourceMetadata: input.sourceMetadata ?? {} };
      },
      // day1 is already stored and complete; day2 is new.
      findByKey: async (_instrumentId, _timeframe, openTime) =>
        openTime.getTime() === day1.getTime() ? existingComplete : null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const provider: HistoricalMarketDataProvider = {
      id: "test-provider",
      fetchCandles: async () => [
        // day1 comes back with revised OHLC (101 vs stored 100), the real trigger.
        { openTime: day1, closeTime: new Date("2025-01-01T10:00:00Z"), open: "101", high: "111", low: "96", close: "106", volume: "12" },
        { openTime: day2, closeTime: new Date("2025-01-02T10:00:00Z"), open: "106", high: "112", low: "104", close: "110", volume: "9" },
      ],
    };
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, candles);

    await expect(service.execute({
      instrument, provider, providerInstrumentId: "256265", timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"), to: new Date("2025-01-02T23:59:59Z"),
      skipExisting: true,
    })).resolves.toMatchObject({ candlesFetched: 2, candlesPersisted: 1, candlesSkipped: 1 });

    // Only the genuinely-new bar was written; the already-stored one was skipped.
    expect(stored).toHaveLength(1);
    expect(stored[0].openTime.toISOString()).toBe("2025-01-02T03:45:00.000Z");
    expect(ingestion.completed).toEqual([1]);
    expect(ingestion.failures).toHaveLength(0);
  });

  it("marks the ingestion as failed when a provider returns duplicate timestamps", async () => {
    const provider: HistoricalMarketDataProvider = {
      id: "test-provider",
      fetchCandles: async () => Array.from({ length: 2 }, () => ({
        openTime: new Date("2025-01-01T03:45:00Z"),
        closeTime: new Date("2025-01-01T10:00:00Z"),
        open: "100", high: "110", low: "95", close: "105", volume: "10",
      })),
    };
    const ingestion = ingestionRepository();
    const candles: CandleRepository = {
      upsert: async () => { throw new Error("not reached"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const service = new ImportHistoricalMarketData(ingestion.repository, candles);

    await expect(service.execute({
      instrument, provider, providerInstrumentId: "256265", timeframe: "1d",
      from: new Date("2025-01-01T00:00:00Z"), to: new Date("2025-01-01T23:59:59Z"),
    })).rejects.toThrow("duplicate candle timestamp");
    expect(ingestion.failures).toHaveLength(1);
  });
});

describe("ImportHistoricalMarketData invalid-candle handling", () => {
  function repository(stored: UpsertCandleInput[]): CandleRepository {
    return {
      upsert: async (input): Promise<PersistedCandle> => {
        stored.push(input);
        return { id: "candle", ...input, ingestionId: input.ingestionId ?? null, sourceMetadata: input.sourceMetadata ?? {} };
      },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
  }

  // Fyers returned exactly this shape for one NIFTYBEES 5m opening bar on
  // 2023-09-21: an `open` of 213 sitting below the bar's own `low` of 218.33.
  const corrupt = {
    openTime: new Date("2023-09-21T03:45:00Z"),
    closeTime: new Date("2023-09-21T03:50:00Z"),
    open: "213", high: "219.29", low: "218.33", close: "218.57", volume: "100489",
  };
  const sound = {
    openTime: new Date("2023-09-21T03:50:00Z"),
    closeTime: new Date("2023-09-21T03:55:00Z"),
    open: "218.5", high: "219", low: "218.2", close: "218.9", volume: "5000",
  };

  function providerWith(candles: typeof sound[]): HistoricalMarketDataProvider {
    return { id: "test-provider", fetchCandles: async () => candles };
  }

  const window = {
    instrument,
    providerInstrumentId: "NSE:NIFTYBEES-EQ",
    timeframe: "5m" as const,
    from: new Date("2023-09-21T00:00:00Z"),
    to: new Date("2023-09-21T23:59:59Z"),
  };

  it("aborts on a corrupt candle by default, writing nothing", async () => {
    const stored: UpsertCandleInput[] = [];
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, repository(stored));

    await expect(service.execute({ ...window, provider: providerWith([corrupt, sound]) }))
      .rejects.toThrow(/OHLC bounds/);
    expect(stored).toHaveLength(0);
    expect(ingestion.completed).toEqual([]);
  });

  it("drops the corrupt candle under skipInvalid, keeps the sound one, and reports both", async () => {
    const stored: UpsertCandleInput[] = [];
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, repository(stored));

    const result = await service.execute({
      ...window,
      provider: providerWith([corrupt, sound]),
      skipInvalid: true,
    });

    expect(result).toMatchObject({ candlesFetched: 2, candlesPersisted: 1, candlesRejected: 1 });
    // A silent drop would be indistinguishable from a market holiday, so the
    // rejection must be diagnosable from the result alone.
    expect(result.rejectedSamples).toEqual([
      { openTime: "2023-09-21T03:45:00.000Z", reason: expect.stringMatching(/OHLC bounds/) },
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].open).toBe("218.5");
  });

  it("reports zero rejections when every candle is sound", async () => {
    const stored: UpsertCandleInput[] = [];
    const ingestion = ingestionRepository();
    const service = new ImportHistoricalMarketData(ingestion.repository, repository(stored));

    const result = await service.execute({
      ...window,
      provider: providerWith([sound]),
      skipInvalid: true,
    });

    expect(result).toMatchObject({ candlesRejected: 0, rejectedSamples: [] });
  });
});
