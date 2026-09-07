import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import type {
  CandleFeatureCoverageRepository,
  PatternDefinitionRepository,
  PatternDetectionRepository,
  PriceActionEventRepository,
} from "../domain/market-pattern.js";
import { DetectMarketPatterns } from "./detect-market-patterns.js";

function persistedCandle(index: number, open: number, high: number, low: number, close: number): PersistedCandle {
  return {
    id: `candle-${index}`,
    instrumentId: "instrument-1",
    timeframe: "1d",
    openTime: new Date(Date.UTC(2026, 6, 20 + index)),
    closeTime: new Date(Date.UTC(2026, 6, 21 + index)),
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "100",
    isComplete: true,
    source: "test",
    ingestionId: null,
    sourceMetadata: {},
  };
}

describe("DetectMarketPatterns", () => {
  it("persists versioned candlestick evidence and confirmation-time price action", async () => {
    const candles = [
      persistedCandle(0, 10, 11, 9, 10),
      persistedCandle(1, 10, 12, 9, 11),
      persistedCandle(2, 11, 15, 10, 13),
      persistedCandle(3, 13, 14, 11, 12),
      persistedCandle(4, 12, 13, 10, 11),
    ];
    const definitions: Array<{ code: string; algorithmVersion: string }> = [];
    const detections: Array<{ candleId: string; patternDefinitionId: string }> = [];
    const events: Array<{ candleId: string; eventCode: string; algorithmVersion: string; details: Record<string, unknown> }> = [];
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => candles,
    };
    const definitionRepository: PatternDefinitionRepository = {
      ensure: async (input) => {
        definitions.push({ code: input.code, algorithmVersion: input.algorithmVersion });
        return { id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion };
      },
    };
    const detectionRepository: PatternDetectionRepository = {
      upsert: async (input) => { detections.push(input); },
    };
    const eventRepository: PriceActionEventRepository = {
      upsert: async (input) => { events.push(input); },
    };

    const result = await new DetectMarketPatterns(
      candleRepository,
      definitionRepository,
      detectionRepository,
      eventRepository,
    ).execute({ instrumentId: "instrument-1", timeframe: "1d" });

    expect(result).toMatchObject({
      candlesRead: candles.length,
      candlestickDetections: detections.length,
      priceActionEvents: events.length,
    });
    expect(definitions).toContainEqual({ code: "DOJI", algorithmVersion: "candlestick-v1" });
    expect(detections.some((detection) => detection.candleId === "candle-0")).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candleId: "candle-4",
        eventCode: "SWING_HIGH",
        algorithmVersion: "price-action-v2",
        details: expect.objectContaining({ pivotCandleId: "candle-2", confirmationCandleId: "candle-4" }),
      }),
    ]));
  });

  it("marks every candle in the write window as covered, including the ones that detected nothing", async () => {
    // The whole point of the coverage table. `pattern_detections` stores rows only when something is
    // found, so a quiet bar and an unprocessed bar are the same absence -- which is how the scalp
    // research harness spent 2026-08-24 freezing unprocessed bars as though they were quiet.
    const candles = [
      persistedCandle(0, 10, 11, 9, 10),
      persistedCandle(1, 10, 12, 9, 11),
      persistedCandle(2, 11, 15, 10, 13),
      persistedCandle(3, 13, 14, 11, 12),
      persistedCandle(4, 12, 13, 10, 11),
    ];
    const detections: Array<{ candleId: string }> = [];
    const coverage: Array<{ candleIds: readonly string[]; featureLayer: string; algorithmVersion: string }> = [];
    const coverageRepository: CandleFeatureCoverageRepository = {
      record: async (input) => { coverage.push(input); },
    };

    const result = await new DetectMarketPatterns(
      { upsert: async () => { throw new Error("not used"); }, findByKey: async () => null, listIncomplete: async () => [], listCompleted: async () => candles },
      { ensure: async (input) => ({ id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion }) },
      { upsert: async (input) => { detections.push(input); } },
      { upsert: async () => undefined },
      undefined,
      undefined,
      undefined,
      coverageRepository,
    ).execute({ instrumentId: "instrument-1", timeframe: "1d" });

    const layers = Object.fromEntries(coverage.map((entry) => [entry.featureLayer, entry]));
    expect(Object.keys(layers).sort()).toEqual(["CANDLESTICK_PATTERN", "PRICE_ACTION"]);
    // All five, not only the ones that produced a detection.
    expect(layers.CANDLESTICK_PATTERN!.candleIds).toEqual(candles.map((candle) => candle.id));
    expect(layers.PRICE_ACTION!.candleIds).toEqual(candles.map((candle) => candle.id));
    expect(layers.PRICE_ACTION!.algorithmVersion).toBe("price-action-v2");
    expect(result.candlesCovered).toBe(candles.length);
    expect(new Set(detections.map((item) => item.candleId)).size).toBeLessThan(candles.length);
  });

  it("covers only the write window, so a bounded rerun does not claim bars it never wrote", async () => {
    const candles = [
      persistedCandle(0, 10, 11, 9, 10),
      persistedCandle(1, 10, 12, 9, 11),
      persistedCandle(2, 11, 15, 10, 13),
      persistedCandle(3, 13, 14, 11, 12),
      persistedCandle(4, 12, 13, 10, 11),
    ];
    const coverage: Array<{ candleIds: readonly string[] }> = [];

    await new DetectMarketPatterns(
      { upsert: async () => { throw new Error("not used"); }, findByKey: async () => null, listIncomplete: async () => [], listCompleted: async () => candles },
      { ensure: async (input) => ({ id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion }) },
      { upsert: async () => undefined },
      { upsert: async () => undefined },
      undefined,
      undefined,
      undefined,
      { record: async (input) => { coverage.push(input); } },
    ).execute({
      instrumentId: "instrument-1",
      timeframe: "1d",
      // The engines still read the whole series for multi-bar patterns; only writes are bounded.
      since: candles[3]!.openTime,
    });

    expect(coverage[0]!.candleIds).toEqual(["candle-3", "candle-4"]);
  });

  it("records nothing when no coverage repository is supplied, rather than reporting false coverage", async () => {
    // The gate must stay closed for callers that do not stamp: the harness then waits for a pass
    // that does, instead of reading a half-built bar.
    const candles = [persistedCandle(0, 10, 11, 9, 10), persistedCandle(1, 10, 12, 9, 11)];

    const result = await new DetectMarketPatterns(
      { upsert: async () => { throw new Error("not used"); }, findByKey: async () => null, listIncomplete: async () => [], listCompleted: async () => candles },
      { ensure: async (input) => ({ id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion }) },
      { upsert: async () => undefined },
      { upsert: async () => undefined },
    ).execute({ instrumentId: "instrument-1", timeframe: "1d" });

    expect(result.candlesCovered).toBe(0);
  });
});
