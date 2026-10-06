import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { CandlestickPatternEngine } from "../domain/candlestick-pattern-engine.js";
import { ChartPatternEngine } from "../domain/chart-pattern-engine.js";
import {
  candlestickPatternDescriptions,
  candlestickPatternLayer,
  priceActionLayer,
  type CandleFeatureCoverageRepository,
  type PatternCandle,
  type PatternDefinitionRepository,
  type PatternDetectionRepository,
  type PriceActionEventRepository,
} from "../domain/market-pattern.js";
import { PriceActionEngine } from "../domain/price-action-engine.js";

export interface DetectMarketPatternsInput {
  instrumentId: string;
  timeframe: string;
  candlestickAlgorithmVersion?: string;
  priceActionAlgorithmVersion?: string;
  since?: Date;
}

export interface DetectMarketPatternsResult {
  candlesRead: number;
  /** Detected across the whole series. Both engines always run over all of it -- multi-bar
   * patterns and swing pivots need the history -- so this is unaffected by `since`. */
  candlestickDetections: number;
  priceActionEvents: number;
  /**
   * Actually persisted, which `since` *does* bound.
   *
   * Reported separately because the detected counts alone are genuinely misleading: a run with
   * `--from` yesterday reports the same `candlestickDetections` as a full rebuild, which reads as
   * "it rewrote everything" when it wrote almost nothing. That ambiguity cost a wrong reading of
   * a real run, so "how much was computed" and "how much was stored" are now separate numbers.
   */
  candlestickDetectionsWritten: number;
  priceActionEventsWritten: number;
  /** The write boundary applied, or null for the whole series. */
  writesFrom: string | null;
  /**
   * Candles marked as processed by both engines.
   *
   * Distinct from the written counts on purpose: this counts bars the pass *covered*, most of which
   * legitimately produce no detection at all. It is the number a reader needs to tell a quiet bar
   * from one this pass has not reached yet.
   */
  candlesCovered: number;
}

function decimalToNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Persisted candle has invalid ${field} value.`);
  }
  return parsed;
}

function toPatternCandle(candle: PersistedCandle): PatternCandle {
  const open = decimalToNumber(candle.open, "open");
  const high = decimalToNumber(candle.high, "high");
  const low = decimalToNumber(candle.low, "low");
  const close = decimalToNumber(candle.close, "close");
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new Error("Persisted candle has an invalid OHLC range.");
  }
  return {
    id: candle.id,
    openTime: candle.openTime,
    open,
    high,
    low,
    close,
    volume: decimalToNumber(candle.volume, "volume"),
  };
}

function assertChronological(candles: readonly PatternCandle[]): void {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].openTime.getTime() <= candles[index - 1].openTime.getTime()) {
      throw new Error("Completed candles must be strictly chronological for pattern detection.");
    }
  }
}

/**
 * Calculates versioned, explainable pattern hypotheses using completed candles only.
 * It deliberately persists swing events on their confirmation candle rather than
 * retroactively marking the pivot candle, preventing look-ahead in downstream use.
 */
export class DetectMarketPatterns {
  constructor(
    private readonly candleRepository: CandleRepository,
    private readonly patternDefinitionRepository: PatternDefinitionRepository,
    private readonly patternDetectionRepository: PatternDetectionRepository,
    private readonly priceActionEventRepository: PriceActionEventRepository,
    private readonly candlestickEngine = new CandlestickPatternEngine(),
    private readonly priceActionEngine = new PriceActionEngine(),
    private readonly chartPatternEngine = new ChartPatternEngine(),
    /**
     * Last, and optional, so the existing call sites that pass engines positionally keep compiling
     * and behaving identically.
     *
     * The scalp research harness is the one consumer that must know whether a bar was *processed*,
     * and it refuses to capture a minute whose coverage is absent. A caller that omits this
     * therefore leaves that gate closed rather than opening it falsely, which is the safe direction:
     * the harness waits for a pass that does record coverage instead of reading a half-built bar.
     */
    private readonly coverageRepository: CandleFeatureCoverageRepository | null = null,
  ) {}

  async execute(input: DetectMarketPatternsInput): Promise<DetectMarketPatternsResult> {
    const candles = (await this.candleRepository.listCompleted(input.instrumentId, input.timeframe)).map(toPatternCandle);
    assertChronological(candles);

    const candlestickAlgorithmVersion = input.candlestickAlgorithmVersion ?? "candlestick-v1";
    const priceActionAlgorithmVersion = input.priceActionAlgorithmVersion ?? "price-action-v2";
    const patterns = this.candlestickEngine.detect(candles);
    const priceEvents = this.priceActionEngine.detect(candles);
    const chartEvents = this.chartPatternEngine.detect(candles);
    const events = [...priceEvents, ...chartEvents];
    
    const openTimeByCandleId = new Map<string, number>();
    for (const c of candles) {
      openTimeByCandleId.set(c.id, c.openTime.getTime());
    }
    const fromTime = input.since?.getTime() ?? 0;
    let candlestickDetectionsWritten = 0;
    let priceActionEventsWritten = 0;
    
    const definitionsByCode = new Map<string, { id: string }>();

    for (const pattern of patterns) {
      let definition = definitionsByCode.get(pattern.patternCode);
      if (!definition) {
        definition = await this.patternDefinitionRepository.ensure({
          code: pattern.patternCode,
          algorithmVersion: candlestickAlgorithmVersion,
          description: candlestickPatternDescriptions[pattern.patternCode],
        });
        definitionsByCode.set(pattern.patternCode, definition);
      }
      
      const time = openTimeByCandleId.get(pattern.candleId) ?? 0;
      if (time < fromTime) continue;

      await this.patternDetectionRepository.upsert({
        candleId: pattern.candleId,
        patternDefinitionId: definition.id,
        direction: pattern.direction,
        confidence: pattern.confidence,
        contextCandleIds: pattern.contextCandleIds,
        details: pattern.details,
      });
      candlestickDetectionsWritten += 1;
    }

    for (const event of events) {
      const time = openTimeByCandleId.get(event.candleId) ?? 0;
      if (time < fromTime) continue;

      await this.priceActionEventRepository.upsert({
        candleId: event.candleId,
        eventCode: event.eventCode,
        direction: event.direction,
        level: event.level,
        confidence: event.confidence,
        algorithmVersion: priceActionAlgorithmVersion,
        details: event.details,
      });
      priceActionEventsWritten += 1;
    }

    // Stamped over the write window, not the detection window, and stamped for every candle in it
    // rather than only the ones that produced a row. A bar with no pattern is the common case and is
    // exactly the case a reader cannot otherwise distinguish from a bar this pass has not reached.
    // Written last: a crash above must leave the window looking unprocessed, because it is.
    const coveredCandleIds = candles
      .filter((candle) => candle.openTime.getTime() >= fromTime)
      .map((candle) => candle.id);
    if (this.coverageRepository && coveredCandleIds.length > 0) {
      await this.coverageRepository.record({
        candleIds: coveredCandleIds,
        featureLayer: candlestickPatternLayer,
        algorithmVersion: candlestickAlgorithmVersion,
      });
      await this.coverageRepository.record({
        candleIds: coveredCandleIds,
        featureLayer: priceActionLayer,
        algorithmVersion: priceActionAlgorithmVersion,
      });
    }

    return {
      candlesRead: candles.length,
      candlestickDetections: patterns.length,
      priceActionEvents: events.length,
      candlestickDetectionsWritten,
      priceActionEventsWritten,
      writesFrom: input.since?.toISOString() ?? null,
      candlesCovered: this.coverageRepository ? coveredCandleIds.length : 0,
    };
  }
}
