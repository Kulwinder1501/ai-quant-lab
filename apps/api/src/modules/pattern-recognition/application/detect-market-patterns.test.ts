import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import type {
  CandleFeatureCoverageRepository,
  PatternDefinitionRepository,
  PatternDetectionRepository,
  PriceActionEventRepository,
} from "../domain/market-pattern.js";
import { DetectMarketPatterns } from "./detect-market-patterns.js";

const sessionOneStart = Date.parse("2026-08-10T09:30:00Z"); // 15:00 IST
const sessionTwoStart = Date.parse("2026-08-11T03:45:00Z"); // 09:15 IST the next day
const fiveMinutes = 5 * 60 * 1000;

interface BarSpec {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  openTimeMs: number;
}

function intradayCandle(index: number, spec: BarSpec): PersistedCandle {
  return {
    id: `bar-${index}`,
    instrumentId: "instrument-1",
    timeframe: "5m",
    openTime: new Date(spec.openTimeMs),
    closeTime: new Date(spec.openTimeMs + fiveMinutes),
    open: String(spec.open),
    high: String(spec.high),
    low: String(spec.low),
    close: String(spec.close),
    volume: String(spec.volume ?? 100),
    isComplete: true,
    source: "test",
    ingestionId: null,
    sourceMetadata: {},
  };
}

/** Three falling bars, a small bearish bar (index 3), then a bullish bar (index 4) that engulfs it. */
function engulfingSeries(timesMs: readonly number[], volumes: readonly number[] = [100, 100, 100, 100, 100]): PersistedCandle[] {
  const shapes = [
    { open: 14.2, high: 14.5, low: 13.8, close: 14 },
    { open: 13.2, high: 13.5, low: 12.8, close: 13 },
    { open: 12.2, high: 12.5, low: 11.8, close: 12 },
    { open: 10.5, high: 10.6, low: 9.9, close: 10 },
    { open: 9.9, high: 10.9, low: 9.8, close: 10.8 },
  ];
  return shapes.map((shape, index) => intradayCandle(index, { ...shape, volume: volumes[index], openTimeMs: timesMs[index]! }));
}

async function runDetection(
  candles: PersistedCandle[],
  input: { timeframe: string; tickSize?: number },
) {
  const detections: Array<{ candleId: string; contextCandleIds: readonly string[]; details: Record<string, unknown> }> = [];
  const events: Array<{ candleId: string; eventCode: string; details: Record<string, unknown> }> = [];
  const result = await new DetectMarketPatterns(
    { upsert: async () => { throw new Error("not used"); }, findByKey: async () => null, listIncomplete: async () => [], listCompleted: async () => candles },
    { ensure: async (definition) => ({ id: `definition-${definition.code}`, code: definition.code, algorithmVersion: definition.algorithmVersion }) },
    { upsert: async (detection) => { detections.push({ candleId: detection.candleId, contextCandleIds: detection.contextCandleIds, details: detection.details }); } },
    { upsert: async (event) => { events.push({ candleId: event.candleId, eventCode: event.eventCode, details: event.details }); } },
  ).execute({ instrumentId: "instrument-1", ...input });
  return { result, detections, events };
}

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
    expect(definitions).toContainEqual({ code: "DOJI", algorithmVersion: "candlestick-v2" });
    expect(detections.some((detection) => detection.candleId === "candle-0")).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candleId: "candle-4",
        eventCode: "SWING_HIGH",
        algorithmVersion: "price-action-v3",
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
    expect(layers.PRICE_ACTION!.algorithmVersion).toBe("price-action-v3");
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

  it("does not let an intraday pattern use the previous session's bars as its prior bars", async () => {
    const consecutive = [0, 1, 2, 3, 4].map((i) => sessionTwoStart + i * fiveMinutes);
    // Same five bars, but the engulfing bar (index 4) is the 09:15 open of the next session.
    const acrossSessions = [sessionOneStart, sessionOneStart + fiveMinutes, sessionOneStart + 2 * fiveMinutes, sessionOneStart + 3 * fiveMinutes, sessionTwoStart];

    const control = await runDetection(engulfingSeries(consecutive), { timeframe: "5m" });
    const controlEngulfing = control.detections.filter((d) => d.candleId === "bar-4" && d.contextCandleIds.includes("bar-3"));
    expect(controlEngulfing.length).toBeGreaterThan(0);

    const split = await runDetection(engulfingSeries(acrossSessions), { timeframe: "5m" });
    const openingBarDetections = split.detections.filter((d) => d.candleId === "bar-4");
    expect(openingBarDetections.every((d) => d.contextCandleIds.every((id) => id === "bar-4"))).toBe(true);
    expect(split.detections.some((d) => d.contextCandleIds.includes("bar-3") && d.candleId === "bar-4")).toBe(false);
  });

  it("neither triggers nor uses a zero-volume bar when the series otherwise reports volume", async () => {
    const times = [0, 1, 2, 3, 4].map((i) => sessionTwoStart + i * fiveMinutes);
    const stale = await runDetection(engulfingSeries(times, [100, 100, 100, 0, 100]), { timeframe: "5m" });

    expect(stale.detections.some((d) => d.candleId === "bar-3" || d.contextCandleIds.includes("bar-3"))).toBe(false);
    expect(stale.events.some((e) => e.candleId === "bar-3")).toBe(false);
    // The suppressed bar is still counted as read, and the engulfing that needed it is gone.
    expect(stale.result.candlesRead).toBe(5);
    expect(stale.detections.some((d) => d.candleId === "bar-4" && d.contextCandleIds.length > 1 && d.contextCandleIds.includes("bar-3"))).toBe(false);
  });

  it("suppresses a flat zero-volume print but keeps a feed that never reports volume", async () => {
    const times = [0, 1, 2, 3, 4].map((i) => sessionTwoStart + i * fiveMinutes);

    const noVolumeFeed = await runDetection(engulfingSeries(times, [0, 0, 0, 0, 0]), { timeframe: "5m" });
    expect(noVolumeFeed.detections.some((d) => d.candleId === "bar-4" && d.contextCandleIds.includes("bar-3"))).toBe(true);

    const flat = engulfingSeries(times, [0, 0, 0, 0, 0]);
    flat[3] = intradayCandle(3, { open: 10, high: 10, low: 10, close: 10, volume: 0, openTimeMs: times[3]! });
    const withFlatPrint = await runDetection(flat, { timeframe: "5m" });
    expect(withFlatPrint.detections.some((d) => d.candleId === "bar-3" || d.contextCandleIds.includes("bar-3"))).toBe(false);
  });

  it("applies the DOJI range floor from the instrument tick size", async () => {
    const dojiBar = (id: number, ms: number) => intradayCandle(id, { open: 100.05, high: 100.1, low: 100.0, close: 100.05, openTimeMs: ms });
    const times = [sessionTwoStart, sessionTwoStart + fiveMinutes];

    const fineTick = await runDetection([dojiBar(0, times[0]!), dojiBar(1, times[1]!)], { timeframe: "5m", tickSize: 0.01 });
    expect(fineTick.detections.some((d) => d.details.confidenceKind === "HEURISTIC_STRENGTH")).toBe(true);

    // 0.10 range is 2 ticks at 0.05: quantisation noise, not a doji.
    const nseTick = await runDetection([dojiBar(0, times[0]!), dojiBar(1, times[1]!)], { timeframe: "5m", tickSize: 0.05 });
    expect(nseTick.detections.some((d) => d.details.confidenceKind === "HEURISTIC_STRENGTH")).toBe(false);
  });

  it("selects the price-action threshold unit by timeframe", async () => {
    // A rise then a fall, long enough to clear the 14-bar ATR warm-up and confirm a swing high.
    const shape = Array.from({ length: 24 }, (_, i) => {
      const close = 100 + (i <= 12 ? i : 24 - i);
      return { open: close - 0.2, high: close + 1, low: close - 1, close };
    });
    const modes = (events: Array<{ details: Record<string, unknown> }>) => (
      new Set(events.map((e) => e.details.thresholdMode).filter(Boolean))
    );

    const intraday = await runDetection(
      shape.map((bar, i) => intradayCandle(i, { ...bar, openTimeMs: sessionTwoStart + i * fiveMinutes })),
      { timeframe: "5m" },
    );
    expect(intraday.events.length).toBeGreaterThan(0);
    expect(modes(intraday.events)).toEqual(new Set(["ATR"]));

    const daily = await runDetection(
      shape.map((bar, i) => persistedCandle(i, bar.open, bar.high, bar.low, bar.close)),
      { timeframe: "1d" },
    );
    expect(daily.events.length).toBeGreaterThan(0);
    expect(modes(daily.events)).toEqual(new Set(["PERCENT"]));
  });
});
