import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { indicatorParametersHash } from "./indicator-parameters-hash.js";
import {
  defaultIndicatorDefinitions,
  type IndicatorCandle,
  type IndicatorDefinitionRepository,
  type IndicatorDefinitionSpec,
  type IndicatorSnapshotInput,
  type IndicatorSnapshotRepository,
} from "../domain/technical-indicator.js";
import { TechnicalIndicatorEngine } from "../domain/technical-indicator-engine.js";

/**
 * The `warmupBars` the XAU_USD and DXY jobs use. Measured, not guessed: on real XAU_USD and DXY
 * 1m/5m/15m bars (250,000-bar and 100,000-bar references, four different "as of" points each) it
 * reproduced every value the whole-series run writes, except Bollinger Bands by one 1e-8 rounding
 * step in under 2% of rows (which no warm-up length removes). The limit that matters is VWAP,
 * which restarts each IST day, so the warm-up must span a full day: 5,000 1m bars is 3.5 days,
 * and 300 was wrong by up to $22. Every other indicator was exact from 1,000 bars (300 for the
 * swing and structure ones). XAU_USD 1m is 2.4 million bars; reading all of it every run took
 * ~2 minutes and then outgrew a 2 GB heap on 2026-10-30.
 */
export const LONG_SERIES_WARMUP_BARS = 5000;

export interface CalculateTechnicalIndicatorsInput {
  instrumentId: string;
  timeframe: string;
  definitions?: readonly IndicatorDefinitionSpec[];
  since?: Date;
  /**
   * Read only this many bars before `since` (plus everything from it) instead of the whole series.
   * For series too long to recompute every run (XAU_USD 1m is 2.4 million bars; the full read
   * outgrew a 2 GB heap on 2026-10-30). Needs `since`.
   *
   * It does not change what is written for the bars from `since` on, provided the warm-up is
   * long enough: the recursive indicators (EMA, RSI, ATR, MACD) forget older bars geometrically,
   * VWAP restarts each IST day so needs the whole of that day, and the swing/structure
   * indicators resolve at the next break. Measured on real gold and DXY bars, 5,000 bars of
   * warm-up reproduced every written value (Bollinger differs by one 1e-8 rounding step in ~2%
   * of rows, at any length). Without this the whole series is computed, as before.
   */
  warmupBars?: number;
}

export interface CalculateTechnicalIndicatorsResult {
  candlesRead: number;
  definitionsProcessed: number;
  snapshotsWritten: number;
}

function decimalToNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Persisted candle has invalid ${field} value.`);
  }
  return parsed;
}

function toIndicatorCandle(candle: PersistedCandle): IndicatorCandle {
  return {
    id: candle.id,
    openTime: candle.openTime,
    open: decimalToNumber(candle.open, "open"),
    high: decimalToNumber(candle.high, "high"),
    low: decimalToNumber(candle.low, "low"),
    close: decimalToNumber(candle.close, "close"),
    volume: decimalToNumber(candle.volume, "volume"),
  };
}

export class CalculateTechnicalIndicators {
  constructor(
    private readonly candleRepository: CandleRepository,
    private readonly definitionRepository: IndicatorDefinitionRepository,
    private readonly snapshotRepository: IndicatorSnapshotRepository,
    private readonly engine = new TechnicalIndicatorEngine(),
  ) {}

  private async loadCandles(input: CalculateTechnicalIndicatorsInput): Promise<PersistedCandle[]> {
    if (input.warmupBars === undefined) {
      return this.candleRepository.listCompleted(input.instrumentId, input.timeframe);
    }
    if (!input.since) {
      throw new Error("warmupBars bounds the read relative to `since`, so `since` is required.");
    }
    if (!this.candleRepository.listCompletedWindow) {
      // Reading everything instead would be correct but is exactly what the caller asked to avoid.
      throw new Error("This candle repository cannot read a bounded window; omit warmupBars to read the whole series.");
    }
    return this.candleRepository.listCompletedWindow(input.instrumentId, input.timeframe, input.since, input.warmupBars);
  }

  async execute(input: CalculateTechnicalIndicatorsInput): Promise<CalculateTechnicalIndicatorsResult> {
    const candles = (await this.loadCandles(input)).map(toIndicatorCandle);
    const definitions = input.definitions ?? defaultIndicatorDefinitions;
    let snapshotsWritten = 0;
    
    const openTimeByCandleId = new Map<string, number>();
    for (const c of candles) {
      openTimeByCandleId.set(c.id, c.openTime.getTime());
    }
    const fromTime = input.since?.getTime() ?? 0;

    for (const specification of definitions) {
      const definition = await this.definitionRepository.ensure({
        ...specification,
        parametersHash: indicatorParametersHash(specification.parameters),
      });
      // Every indicator is computed over everything that was read, which is the *whole* series
      // unless `warmupBars` bounded the read, because EMA, RSI and the SMC pivots all depend on
      // history. `since` bounds only what is written, which is what makes an every-minute
      // recompute affordable.
      const points = this.engine.calculate(candles, specification);
      const pending: IndicatorSnapshotInput[] = [];
      for (const point of points) {
        const time = openTimeByCandleId.get(point.candleId) ?? 0;
        if (time < fromTime) continue;

        pending.push({
          candleId: point.candleId,
          indicatorDefinitionId: definition.id,
          values: point.values,
        });
      }
      await this.snapshotRepository.upsertMany(pending);
      snapshotsWritten += pending.length;
    }
    return { candlesRead: candles.length, definitionsProcessed: definitions.length, snapshotsWritten };
  }
}
