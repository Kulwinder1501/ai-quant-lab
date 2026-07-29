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
    })).resolves.toMatchObject({ candlesFetched: 1, candlesPersisted: 1 });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ instrumentId: "instrument-1", ingestionId: "ingestion-1", isComplete: true });
    expect(ingestion.completed).toEqual([1]);
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
