import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import type {
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
});
