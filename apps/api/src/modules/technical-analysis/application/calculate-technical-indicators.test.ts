import { describe, expect, it } from "vitest";
import { CalculateTechnicalIndicators } from "./calculate-technical-indicators.js";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import type {
  IndicatorDefinitionRepository,
  IndicatorSnapshotInput,
  IndicatorSnapshotRepository,
} from "../domain/technical-indicator.js";
import { defaultIndicatorDefinitions } from "../domain/technical-indicator.js";

function persistedCandles(count: number): PersistedCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = String(index + 1);
    return {
      id: `candle-${index + 1}`,
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date(Date.UTC(2026, 6, 24, 3, 45 + index)),
      closeTime: new Date(Date.UTC(2026, 6, 24, 3, 46 + index)),
      open: close,
      high: String(index + 2),
      low: String(index),
      close,
      volume: "10",
      isComplete: true,
      source: "test",
      ingestionId: null,
      sourceMetadata: {},
    };
  });
}

describe("CalculateTechnicalIndicators", () => {
  it("registers default definitions and persists only warm snapshots", async () => {
    const definitions: string[] = [];
    const snapshots: Array<{ candleId: string; indicatorDefinitionId: string }> = [];
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => persistedCandles(40),
    };
    const definitionRepository: IndicatorDefinitionRepository = {
      ensure: async (input) => {
        definitions.push(input.code);
        return { id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion, parameters: input.parameters, outputSchema: input.outputSchema };
      },
    };
    const batchSizes: number[] = [];
    const snapshotRepository: IndicatorSnapshotRepository = {
      upsertMany: async (inputs) => { batchSizes.push(inputs.length); snapshots.push(...inputs); },
    };

    const result = await new CalculateTechnicalIndicators(candleRepository, definitionRepository, snapshotRepository)
      .execute({ instrumentId: "instrument-1", timeframe: "1m" });

    // Asserted against the registry rather than a literal, because the count is not the
    // property under test and hardcoding it made this fail the moment the six SMC
    // indicators were added -- a real change, flagged as a regression by an unrelated test.
    expect(definitions).toHaveLength(defaultIndicatorDefinitions.length);
    // The two that a count alone would not protect: a second EMA (period 9, the
    // momentum-scalp fast leg) alongside the period-20 one, and every registered code
    // reaching the processor.
    expect(definitions.filter((code) => code === "EMA")).toHaveLength(4);
    expect(new Set(definitions)).toEqual(new Set(defaultIndicatorDefinitions.map((d) => d.code)));
    expect(result).toMatchObject({
      candlesRead: 40,
      definitionsProcessed: defaultIndicatorDefinitions.length,
      snapshotsWritten: snapshots.length,
    });
    expect(snapshots.some((snapshot) => snapshot.indicatorDefinitionId === "definition-SMA" && snapshot.candleId === "candle-20")).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.indicatorDefinitionId === "definition-RSI" && snapshot.candleId === "candle-15")).toBe(true);
    // One write per definition, not one per snapshot. A per-row write here meant ~810,000
    // awaited round trips for a NIFTY50 1m recompute, on a job that runs every minute.
    expect(batchSizes).toHaveLength(defaultIndicatorDefinitions.length);
  });

  it("writes only snapshots at or after `since`, having still computed the full series", async () => {
    // `since` bounds the write, not the calculation: a 20-period SMA on the last bar needs
    // the nineteen before it, so trimming the input would change the values.
    const written: IndicatorSnapshotInput[] = [];
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => persistedCandles(40),
    };
    const definitionRepository: IndicatorDefinitionRepository = {
      ensure: async (input) => ({
        id: `definition-${input.code}`, code: input.code, algorithmVersion: input.algorithmVersion,
        parameters: input.parameters, outputSchema: input.outputSchema,
      }),
    };
    const snapshotRepository: IndicatorSnapshotRepository = {
      upsertMany: async (inputs) => { written.push(...inputs); },
    };

    // Candle N opens at 03:45+N; this keeps the last five.
    const result = await new CalculateTechnicalIndicators(candleRepository, definitionRepository, snapshotRepository)
      .execute({ instrumentId: "instrument-1", timeframe: "1m", since: new Date(Date.UTC(2026, 6, 24, 4, 20)) });

    expect(result.candlesRead).toBe(40);
    expect(written.length).toBeGreaterThan(0);
    const keptBars = new Set(written.map((snapshot) => Number(snapshot.candleId.replace("candle-", ""))));
    expect(Math.min(...keptBars)).toBe(36);
    // The SMA on bar 40 is only correct if bars 21-39 were part of the calculation.
    const sma40 = written.find((s) => s.candleId === "candle-40" && s.indicatorDefinitionId === "definition-SMA");
    expect(sma40?.values.value).toBeCloseTo(30.5, 6);
  });
});
