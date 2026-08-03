import type { CandleRepository, UpsertCandleInput } from "../domain/candle.js";
import type { HistoricalMarketCandle, HistoricalMarketDataProvider, HistoricalTimeframe } from "../domain/historical-data-provider.js";
import type { Instrument } from "../domain/instrument.js";
import type { MarketDataIngestionRepository } from "../domain/market-data-ingestion.js";

export interface ImportHistoricalMarketDataInput {
  instrument: Instrument;
  providerInstrumentId: string;
  provider: HistoricalMarketDataProvider;
  timeframe: HistoricalTimeframe;
  from: Date;
  to: Date;
  /**
   * When true, dates already stored as completed candles are left untouched
   * instead of re-written. Providers such as Yahoo re-issue slightly revised OHLC
   * on a re-fetch, which trips the repository's (correct) immutability guard and
   * aborts an otherwise-successful backfill. This makes an overlapping re-run
   * idempotent. Default false preserves the strict behaviour.
   */
  skipExisting?: boolean;
  /**
   * When true, a candle that fails validation is counted and dropped instead of
   * aborting the batch. Upstream data carries occasional corrupt prints — Fyers
   * returned one NIFTYBEES 5m opening bar whose `open` sat below its own `low`, one
   * bar in 25,159 — and letting a single bad tick block a multi-year backfill is the
   * wrong trade. The rejected count and samples are reported, never swallowed: a
   * silent drop would be indistinguishable from a market holiday.
   *
   * Default false preserves the strict abort, which is correct for CSV fixtures where
   * any invalid row means the file is wrong.
   */
  skipInvalid?: boolean;
}

export interface ImportHistoricalMarketDataResult {
  ingestionId: string;
  provider: string;
  candlesFetched: number;
  candlesPersisted: number;
  /** Completed candles left untouched because they were already stored (skipExisting). */
  candlesSkipped: number;
  /** Candles dropped for failing validation under `skipInvalid`. Zero when strict. */
  candlesRejected: number;
  /** Up to five rejected candles, so a bad upstream print is diagnosable. */
  rejectedSamples: Array<{ openTime: string; reason: string }>;
}

function isPositiveDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

function validateCandle(candle: HistoricalMarketCandle): void {
  if (!(candle.openTime instanceof Date) || Number.isNaN(candle.openTime.getTime())) {
    throw new Error("A historical candle has an invalid opening timestamp.");
  }
  if (!(candle.closeTime instanceof Date) || candle.closeTime <= candle.openTime) {
    throw new Error("A historical candle must close after it opens.");
  }
  if (![candle.open, candle.high, candle.low, candle.close].every(isPositiveDecimal)) {
    throw new Error("A historical candle contains an invalid OHLC price.");
  }
  if (!/^\d+(?:\.\d+)?$/.test(candle.volume) || Number(candle.volume) < 0) {
    throw new Error("A historical candle contains an invalid volume.");
  }

  const [open, high, low, close] = [candle.open, candle.high, candle.low, candle.close].map(Number);
  if (high < open || high < close || high < low || low > open || low > close) {
    throw new Error("A historical candle violates OHLC bounds.");
  }
}

function toPersistenceInput(
  candle: HistoricalMarketCandle,
  input: ImportHistoricalMarketDataInput,
  now: Date,
): UpsertCandleInput {
  // Providers (Yahoo especially) return the in-progress session bar with a
  // projected close_time still ahead of wall clock. Marking that bar complete
  // made GenerateTradeIdeas treat a mid-session print as a settled close.
  const isComplete = candle.closeTime.getTime() <= now.getTime();
  return {
    instrumentId: input.instrument.id,
    timeframe: input.timeframe,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete,
    source: input.provider.id,
    sourceMetadata: { providerInstrumentId: input.providerInstrumentId },
  };
}

/**
 * Coordinates ingestion and keeps the provider adapter outside the application rule.
 * Settled provider bars are stored complete; a bar whose close is still ahead of
 * wall clock stays provisional so live updates and strategy evaluation can own it.
 */
export class ImportHistoricalMarketData {
  constructor(
    private readonly ingestionRepository: MarketDataIngestionRepository,
    private readonly candleRepository: CandleRepository,
  ) {}

  async execute(input: ImportHistoricalMarketDataInput): Promise<ImportHistoricalMarketDataResult> {
    if (input.from >= input.to) {
      throw new Error("The historical import start must be before its end.");
    }
    if (!input.providerInstrumentId.trim()) {
      throw new Error("A provider-specific instrument ID is required for historical collection.");
    }

    const ingestion = await this.ingestionRepository.start({
      provider: input.provider.id,
      mode: "HISTORICAL",
      requestMetadata: {
        instrumentId: input.instrument.id,
        symbol: input.instrument.symbol,
        providerInstrumentId: input.providerInstrumentId,
        timeframe: input.timeframe,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
    });

    try {
      const fetched = await input.provider.fetchCandles({
        providerInstrumentId: input.providerInstrumentId,
        timeframe: input.timeframe,
        from: input.from,
        to: input.to,
      });
      const timestamps = new Set<number>();
      const inRange = fetched
        .filter((candle) => candle.openTime >= input.from && candle.openTime <= input.to)
        .sort((left, right) => left.openTime.getTime() - right.openTime.getTime());

      // Validate the whole batch before any write, preventing malformed files
      // from creating a partially imported sequence.
      const candles: HistoricalMarketCandle[] = [];
      const rejectedSamples: Array<{ openTime: string; reason: string }> = [];
      let candlesRejected = 0;
      for (const candle of inRange) {
        try {
          validateCandle(candle);
        } catch (error) {
          if (!input.skipInvalid) throw error;
          candlesRejected += 1;
          if (rejectedSamples.length < 5) {
            rejectedSamples.push({
              openTime: candle.openTime instanceof Date && !Number.isNaN(candle.openTime.getTime())
                ? candle.openTime.toISOString()
                : "unparseable timestamp",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }
        const timestamp = candle.openTime.getTime();
        if (timestamps.has(timestamp)) {
          throw new Error(`Provider returned duplicate candle timestamp ${candle.openTime.toISOString()}.`);
        }
        timestamps.add(timestamp);
        candles.push(candle);
      }
      let candlesSkipped = 0;
      const now = new Date();
      for (const candle of candles) {
        if (input.skipExisting) {
          const existing = await this.candleRepository.findByKey(
            input.instrument.id,
            input.timeframe,
            candle.openTime,
          );
          // Only an already-*completed* candle is skipped. An incomplete one is
          // still allowed to be finalised by this write.
          if (existing?.isComplete) {
            candlesSkipped += 1;
            continue;
          }
        }
        await this.candleRepository.upsert({
          ...toPersistenceInput(candle, input, now),
          ingestionId: ingestion.id,
        });
      }

      const candlesPersisted = candles.length - candlesSkipped;
      await this.ingestionRepository.complete(ingestion.id, candlesPersisted);
      return {
        ingestionId: ingestion.id,
        provider: input.provider.id,
        candlesFetched: fetched.length,
        candlesPersisted,
        candlesSkipped,
        candlesRejected,
        rejectedSamples,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown historical import failure.";
      try {
        await this.ingestionRepository.fail(ingestion.id, message);
      } catch (ingestionError) {
        console.error("Unable to mark historical ingestion as failed", ingestionError);
      }
      throw error;
    }
  }
}
