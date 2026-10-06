import { addDecimals, compareDecimals, nonNegativeDifference } from "../domain/decimal.js";
import type { CandleRepository, PersistedCandle, UpsertCandleInput } from "../domain/candle.js";
import { CompletedCandleImmutableError } from "../domain/candle.js";
import type { HistoricalTimeframe } from "../domain/historical-data-provider.js";
import type { Instrument } from "../domain/instrument.js";
import type { LiveMarketDataProvider, LiveMarketQuote } from "../domain/live-market-data-provider.js";
import { NseMarketSession } from "../domain/nse-market-session.js";

export interface LiveMarketSubscription {
  instrument: Instrument;
  providerInstrumentId: string;
}

export interface CollectLiveMarketDataInput {
  subscriptions: LiveMarketSubscription[];
  timeframe: HistoricalTimeframe;
  ingestionId: string;
  now?: Date;
}

export interface CollectLiveMarketDataResult {
  quotesReceived: number;
  quotesApplied: number;
  candlesFinalized: number;
}

interface ActiveCandle {
  subscription: LiveMarketSubscription;
  candle: PersistedCandle;
  lastCumulativeVolume: string | null;
}

function activeCandleKey(instrumentId: string, timeframe: HistoricalTimeframe): string {
  return `${instrumentId}:${timeframe}`;
}

function metadataDecimal(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
}

function quoteTimestamp(quote: LiveMarketQuote): Date {
  return quote.exchangeTimestamp ?? quote.observedAt;
}

function updateMetadata(
  candle: PersistedCandle,
  subscription: LiveMarketSubscription,
  quote: LiveMarketQuote,
): Record<string, unknown> {
  return {
    ...candle.sourceMetadata,
    providerInstrumentId: subscription.providerInstrumentId,
    cumulativeVolume: quote.cumulativeVolume,
    quoteObservedAt: quote.observedAt.toISOString(),
    exchangeTimestamp: quote.exchangeTimestamp?.toISOString() ?? null,
  };
}

function toUpsertInput(candle: PersistedCandle): UpsertCandleInput {
  return {
    instrumentId: candle.instrumentId,
    ingestionId: candle.ingestionId,
    timeframe: candle.timeframe,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isComplete: candle.isComplete,
    source: candle.source,
    sourceMetadata: candle.sourceMetadata,
  };
}

/**
 * Aggregates read-only quote snapshots into provisional OHLCV candles, then
 * seals them when their NSE time window closes. It contains no order logic.
 */
export class CollectLiveMarketData {
  private readonly activeCandles = new Map<string, ActiveCandle>();
  private readonly lastCumulativeVolumes = new Map<string, string>();
  /**
   * When this collector began observing. A window that opened before it is one this process
   * cannot have seen in full.
   *
   * Measured on 2026-08-07: a collector started at 08:12 sealed the 08:00-08:15 NIFTY50 bar
   * with a range of **0.9 points** and BANKNIFTY's with **0.5**, from three minutes of
   * quotes. Both were marked complete, so `listCompleted` fed them to the strategies and the
   * indicator engine, and a later historical fetch would have skipped them as
   * already-present. A partial bar wearing a completed bar's clothes is worse than a missing
   * one: the gap is visible and self-heals, the fake does neither.
   *
   * A partially-observed window is therefore never started and never sealed. It is left
   * absent, or left incomplete if an earlier run created it, and the historical fetch fills
   * it properly once the session has settled.
   */
  private readonly observationStartedAt: Date;

  constructor(
    private readonly provider: LiveMarketDataProvider,
    private readonly candleRepository: CandleRepository,
    private readonly marketSession: NseMarketSession,
    observationStartedAt?: Date,
  ) {
    this.observationStartedAt = observationStartedAt ?? new Date();
  }

  async execute(input: CollectLiveMarketDataInput): Promise<CollectLiveMarketDataResult> {
    const now = input.now ?? new Date();
    const finalized = await this.finalizeStaleCandles(input.subscriptions, input.timeframe, now);
    if (!this.marketSession.isOpen(now) || input.subscriptions.length === 0) {
      return { quotesReceived: 0, quotesApplied: 0, candlesFinalized: finalized };
    }

    const quoteByProviderId = new Map<string, LiveMarketQuote>();
    const quotes = await this.provider.fetchQuotes(input.subscriptions.map((subscription) => subscription.providerInstrumentId));
    for (const quote of quotes) {
      quoteByProviderId.set(quote.providerInstrumentId, quote);
    }

    let quotesApplied = 0;
    let candlesFinalized = finalized;
    for (const subscription of input.subscriptions) {
      const quote = quoteByProviderId.get(subscription.providerInstrumentId);
      if (!quote) {
        continue;
      }
      const result = await this.applyQuote(subscription, quote, input.timeframe, input.ingestionId, now);
      quotesApplied += result.applied ? 1 : 0;
      candlesFinalized += result.finalized;
    }
    return { quotesReceived: quotes.length, quotesApplied, candlesFinalized };
  }

  private async applyQuote(
    subscription: LiveMarketSubscription,
    quote: LiveMarketQuote,
    timeframe: HistoricalTimeframe,
    ingestionId: string,
    collectionTime: Date,
  ): Promise<{ applied: boolean; finalized: number }> {
    if (compareDecimals(quote.lastPrice, "0") <= 0) {
      throw new Error(`Live provider returned a non-positive price for ${subscription.providerInstrumentId}.`);
    }
    const quoteTime = quoteTimestamp(quote);
    const collectionSession = this.marketSession.getSession(collectionTime);
    const quoteSession = this.marketSession.getSession(quoteTime);
    if (!collectionSession || !quoteSession || collectionSession.opensAt.getTime() !== quoteSession.opensAt.getTime()) {
      return { applied: false, finalized: 0 };
    }
    const window = this.marketSession.candleWindow(quoteTime, timeframe);
    if (!window) {
      return { applied: false, finalized: 0 };
    }
    // A window that opened before this collector did cannot be observed in full, so it is
    // not started at all. Nothing is lost: the historical fetch delivers that bar settled and
    // on-grid once the session closes.
    if (window.openTime.getTime() < this.observationStartedAt.getTime()) {
      return { applied: false, finalized: 0 };
    }

    // One collector may aggregate several timeframes for the same instrument. Keying only by
    // instrument let the first timeframe (1m in deployment) occupy the slot; 5m/15m/60m then
    // mutated or rejected that 1m state instead of creating their own candles.
    const key = activeCandleKey(subscription.instrument.id, timeframe);
    let active = this.activeCandles.get(key);
    if (!active) {
      const existing = await this.candleRepository.findByKey(subscription.instrument.id, timeframe, window.openTime);
      if (existing?.isComplete) {
        return { applied: false, finalized: 0 };
      }
      active = existing
        ? {
          subscription,
          candle: existing,
          lastCumulativeVolume: metadataDecimal(existing.sourceMetadata, "cumulativeVolume")
            ?? this.lastCumulativeVolumes.get(key)
            ?? null,
        }
        : {
          subscription,
          candle: {
            id: "",
            instrumentId: subscription.instrument.id,
            timeframe,
            openTime: window.openTime,
            closeTime: window.closeTime,
            open: quote.lastPrice,
            high: quote.lastPrice,
            low: quote.lastPrice,
            close: quote.lastPrice,
            volume: "0",
            isComplete: false,
            source: this.provider.id,
            ingestionId,
            sourceMetadata: {},
          },
          lastCumulativeVolume: this.lastCumulativeVolumes.get(key) ?? null,
        };
      if (existing && existing.source !== this.provider.id) {
        throw new Error(`Cannot merge live provider ${this.provider.id} into provisional candle from ${existing.source}.`);
      }
      this.activeCandles.set(key, active);
    }

    if (window.openTime < active.candle.openTime) {
      return { applied: false, finalized: 0 };
    }

    let finalized = 0;
    if (window.openTime > active.candle.openTime) {
      // Not counted as finalized if the authoritative writer already sealed it -- it did the
      // sealing, and reporting it here would double-count the same bar.
      const sealed = await this.sealUnlessSettled({ ...active.candle, isComplete: true });
      finalized = sealed ? 1 : 0;
      active = {
        subscription,
        candle: {
          id: "",
          instrumentId: subscription.instrument.id,
          timeframe,
          openTime: window.openTime,
          closeTime: window.closeTime,
          open: quote.lastPrice,
          high: quote.lastPrice,
          low: quote.lastPrice,
          close: quote.lastPrice,
          volume: "0",
          isComplete: false,
          source: this.provider.id,
          ingestionId,
          sourceMetadata: {},
        },
        lastCumulativeVolume: active.lastCumulativeVolume ?? this.lastCumulativeVolumes.get(key) ?? null,
      };
      this.activeCandles.set(key, active);
    }

    const deltaVolume = quote.cumulativeVolume && active.lastCumulativeVolume
      ? nonNegativeDifference(quote.cumulativeVolume, active.lastCumulativeVolume)
      : "0";
    active.candle = {
      ...active.candle,
      high: compareDecimals(quote.lastPrice, active.candle.high) > 0 ? quote.lastPrice : active.candle.high,
      low: compareDecimals(quote.lastPrice, active.candle.low) < 0 ? quote.lastPrice : active.candle.low,
      close: quote.lastPrice,
      volume: addDecimals(active.candle.volume, deltaVolume),
      sourceMetadata: updateMetadata(active.candle, subscription, quote),
    };
    if (quote.cumulativeVolume) {
      active.lastCumulativeVolume = quote.cumulativeVolume;
      this.lastCumulativeVolumes.set(key, quote.cumulativeVolume);
    }
    const stored = await this.sealUnlessSettled(active.candle);
    if (!stored) {
      // The settled series overtook the window we were still building. Drop our copy rather
      // than keep re-offering it: the next quote takes the `!active` path above, reads the
      // completed bar, and skips the window for good.
      this.activeCandles.delete(key);
      return { applied: false, finalized };
    }
    active.candle = stored;
    this.activeCandles.set(key, active);
    return { applied: true, finalized };
  }

  /**
   * Writes a candle, treating "a settled bar already owns this window" as an ordinary outcome.
   *
   * This collector and `ImportHistoricalMarketData` write the same bars on purpose:
   * INDICES_INTRADAY re-fetches NIFTY50 and BANKNIFTY every minute, so an index window this
   * process is mid-way through building is routinely sealed underneath it. Treating that as
   * fatal is what crash-looped `live-collector-v2` on 2026-08-26 -- 19 restarts, while the
   * ETF collector running the same CLI never restarted once, because nothing else writes
   * NIFTYBEES or BANKBEES intraday.
   *
   * Yielding is also the better bar. The settled fetch is on-grid with real traded volume;
   * this one is aggregated from at most two quote samples a minute.
   *
   * Narrow by construction: the repository refuses only when the stored bar is complete *and*
   * carries no `quoteObservedAt`, so this can never swallow a rejection of one of our own
   * candles. Anything else still propagates and still stops the process.
   */
  private async sealUnlessSettled(candle: PersistedCandle): Promise<PersistedCandle | null> {
    try {
      return await this.candleRepository.upsert(toUpsertInput(candle));
    } catch (error) {
      if (error instanceof CompletedCandleImmutableError) return null;
      throw error;
    }
  }

  private async finalizeStaleCandles(
    subscriptions: LiveMarketSubscription[],
    timeframe: HistoricalTimeframe,
    now: Date,
  ): Promise<number> {
    const pending = await this.candleRepository.listIncomplete(
      subscriptions.map((subscription) => subscription.instrument.id),
      timeframe,
      now,
    );
    let finalized = 0;
    for (const candle of pending) {
      // Only a window this process watched from the start may be sealed. An incomplete bar
      // left by an earlier run is partial by definition -- its collector died mid-window --
      // and sealing it would make a guess permanent. Left incomplete it is excluded from
      // `listCompleted`, and the historical fetch overwrites it, because `skipExisting`
      // skips only completed candles.
      if (candle.openTime.getTime() < this.observationStartedAt.getTime()) {
        continue;
      }
      const sealed = await this.sealUnlessSettled({ ...candle, isComplete: true });
      // Dropped either way: whoever sealed the window, our cached copy of it is now stale.
      this.activeCandles.delete(activeCandleKey(candle.instrumentId, timeframe));
      if (sealed) finalized += 1;
    }
    return finalized;
  }
}
