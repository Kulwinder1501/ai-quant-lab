import { isAtOrAfterSessionEntryCutoff } from "../../paper-trading/domain/session-close.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import { evaluateCounterBiasVariant, type IctShadowSignal } from "../domain/ict-shadow-variant.js";
import { resolveShadowSignal, type ShadowResolution } from "../domain/ict-shadow-resolution.js";
import type { StrategyMarketContext } from "../domain/strategy.js";

/**
 * Captures and settles the shadow variants of the live ICT strategy. Nothing here can trade: the
 * ports below are a context reader and an append-only signal store, and there is no account, order
 * or idea writer to reach.
 *
 * The four cells are the two live ICT bots' series plus their opposite timeframes, because the
 * strategy's own backtest changed sign between 5m and 15m and between instruments. Capturing all
 * four costs nothing and keeps the comparison from being chosen after the fact.
 */
export const ICT_SHADOW_SERIES: ReadonlyArray<{ readonly symbol: string; readonly timeframe: string }> = [
  { symbol: "NIFTY50", timeframe: "15m" },
  { symbol: "NIFTY50", timeframe: "5m" },
  { symbol: "BANKNIFTY", timeframe: "5m" },
  { symbol: "BANKNIFTY", timeframe: "15m" },
];

export interface CapturedSignal extends IctShadowSignal {
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly sourceCandleId: string;
  readonly barCloseTime: Date;
}

export interface CapturePorts {
  findInstrumentId(symbol: string): Promise<string | null>;
  findLatestCompleted(input: { instrumentId: string; timeframe: string }): Promise<StrategyMarketContext | null>;
  insert(signal: CapturedSignal): Promise<boolean>;
}

export interface CaptureSeriesResult {
  readonly symbol: string;
  readonly timeframe: string;
  readonly status: "EVALUATED" | "NO_INSTRUMENT" | "NO_BAR" | "FAILED";
  readonly signals: number;
  readonly inserted: number;
  readonly skippedAtCutoff: number;
  readonly error?: string;
}

export async function captureIctShadowSignals(
  ports: CapturePorts,
  now: Date,
  series: ReadonlyArray<{ symbol: string; timeframe: string }> = ICT_SHADOW_SERIES,
): Promise<CaptureSeriesResult[]> {
  const results: CaptureSeriesResult[] = [];
  for (const { symbol, timeframe } of series) {
    // Each series is isolated: one failing context load must not cost the other three.
    try {
      const instrumentId = await ports.findInstrumentId(symbol);
      if (instrumentId === null) {
        results.push({ symbol, timeframe, status: "NO_INSTRUMENT", signals: 0, inserted: 0, skippedAtCutoff: 0 });
        continue;
      }
      const context = await ports.findLatestCompleted({ instrumentId, timeframe });
      if (context === null) {
        results.push({ symbol, timeframe, status: "NO_BAR", signals: 0, inserted: 0, skippedAtCutoff: 0 });
        continue;
      }

      const signals = evaluateCounterBiasVariant(context);
      // A signal that closes at or after the live entry cutoff could never have been taken.
      const takeable = isAtOrAfterSessionEntryCutoff(context.candle.closeTime) ? [] : signals;
      let inserted = 0;
      for (const signal of takeable) {
        const wasNew = await ports.insert({
          ...signal,
          instrumentId,
          timeframe,
          sourceCandleId: context.candle.id,
          barCloseTime: context.candle.closeTime,
          details: {
            ...signal.details,
            barAgeSecondsAtCapture: Math.round((now.getTime() - context.candle.closeTime.getTime()) / 1000),
          },
        });
        if (wasNew) inserted += 1;
      }
      results.push({
        symbol, timeframe, status: "EVALUATED",
        signals: signals.length, inserted, skippedAtCutoff: signals.length - takeable.length,
      });
    } catch (error) {
      results.push({
        symbol, timeframe, status: "FAILED", signals: 0, inserted: 0, skippedAtCutoff: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export interface ResolvePorts {
  listUnresolved(limit: number): Promise<Array<{
    id: string; instrumentId: string; side: "LONG" | "SHORT";
    entryPrice: number; stopLoss: number; targetPrice: number; barCloseTime: Date;
  }>>;
  loadOneMinuteBars(instrumentId: string, from: Date, to: Date): Promise<CompletedPriceCandle[]>;
  recordResolution(id: string, resolution: ShadowResolution, resolvedAt: Date): Promise<boolean>;
}

export interface ResolveSummary {
  readonly considered: number;
  readonly settled: number;
  readonly open: number;
  readonly deferred: number;
  readonly unmeasurable: number;
}

export async function resolveIctShadowSignals(ports: ResolvePorts, now: Date, limit = 500): Promise<ResolveSummary> {
  const pending = await ports.listUnresolved(limit);
  const byInstrument = new Map<string, typeof pending>();
  for (const signal of pending) {
    byInstrument.set(signal.instrumentId, [...(byInstrument.get(signal.instrumentId) ?? []), signal]);
  }

  const tally = { settled: 0, open: 0, deferred: 0, unmeasurable: 0 };
  for (const [instrumentId, signals] of byInstrument) {
    // One read of the 1m series covering every pending signal for the instrument.
    const from = new Date(Math.min(...signals.map((signal) => signal.barCloseTime.getTime())));
    const bars = await ports.loadOneMinuteBars(instrumentId, from, now);
    for (const signal of signals) {
      const resolution = resolveShadowSignal({ ...signal, bars, now });
      if (resolution.status === "RESOLVED") {
        if (await ports.recordResolution(signal.id, resolution, now)) tally.settled += 1;
      } else if (resolution.status === "UNMEASURABLE") {
        if (await ports.recordResolution(signal.id, resolution, now)) tally.unmeasurable += 1;
      } else if (resolution.status === "DEFERRED_GAP") {
        tally.deferred += 1;
      } else {
        tally.open += 1;
      }
    }
  }
  return { considered: pending.length, ...tally };
}
