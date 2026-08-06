import { describe, expect, it } from "vitest";
import { CalculateTechnicalIndicators } from "./calculate-technical-indicators.js";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import type { IndicatorDefinitionRepository, IndicatorSnapshotRepository } from "../domain/technical-indicator.js";
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
    const snapshotRepository: IndicatorSnapshotRepository = {
      upsert: async (input) => { snapshots.push(input); },
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
    expect(definitions.filter((code) => code === "EMA")).toHaveLength(2);
    expect(new Set(definitions)).toEqual(new Set(defaultIndicatorDefinitions.map((d) => d.code)));
    expect(result).toMatchObject({
      candlesRead: 40,
      definitionsProcessed: defaultIndicatorDefinitions.length,
      snapshotsWritten: snapshots.length,
    });
    expect(snapshots.some((snapshot) => snapshot.indicatorDefinitionId === "definition-SMA" && snapshot.candleId === "candle-20")).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.indicatorDefinitionId === "definition-RSI" && snapshot.candleId === "candle-15")).toBe(true);
  });
});
