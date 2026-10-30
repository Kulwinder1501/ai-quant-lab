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

  describe("warmupBars", () => {
    // A seeded random walk with volume, long enough to span three IST days, so that VWAP's daily
    // restart and the recursive indicators both have something to disagree about.
    function walk(count: number): PersistedCandle[] {
      let state = 0x2f6e2b1;
      const next = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      let previousClose = 2000;
      return Array.from({ length: count }, (_, index) => {
        const open = previousClose;
        const close = open + (next() - 0.5) * 4;
        const high = Math.max(open, close) + next() * 1.5;
        const low = Math.min(open, close) - next() * 1.5;
        previousClose = close;
        return {
          id: `candle-${index}`, instrumentId: "instrument-1", timeframe: "1m",
          openTime: new Date(Date.UTC(2026, 6, 1, 0, index)), closeTime: new Date(Date.UTC(2026, 6, 1, 0, index + 1)),
          open: open.toFixed(4), high: high.toFixed(4), low: low.toFixed(4), close: close.toFixed(4),
          volume: String(10 + Math.floor(next() * 90)), isComplete: true, source: "test", ingestionId: null, sourceMetadata: {},
        };
      });
    }

    const series = walk(4000);
    // Bar 3000 opens ~50 hours in, 07:30 IST on the third day: mid-session, 450 bars after VWAP restarted.
    const since = series[3000].openTime;

    async function run(warmupBars: number | undefined, windowCapable = true) {
      const calls = { listCompleted: 0, window: [] as Array<{ since: Date; warmupBars: number }> };
      const candleRepository: CandleRepository = {
        upsert: async () => { throw new Error("not used"); },
        findByKey: async () => null,
        listIncomplete: async () => [],
        listCompleted: async () => { calls.listCompleted += 1; return series; },
        ...(windowCapable ? {
          listCompletedWindow: async (_instrumentId: string, _timeframe: string, from: Date, warmup: number) => {
            calls.window.push({ since: from, warmupBars: warmup });
            const first = series.findIndex((candle) => candle.openTime >= from);
            return series.slice(Math.max(0, first - warmup));
          },
        } : {}),
      };
      const definitionRepository: IndicatorDefinitionRepository = {
        ensure: async (input) => ({
          id: `${input.code}:${JSON.stringify(input.parameters)}`, code: input.code, algorithmVersion: input.algorithmVersion,
          parameters: input.parameters, outputSchema: input.outputSchema,
        }),
      };
      const written = new Map<string, Record<string, unknown>>();
      const snapshotRepository: IndicatorSnapshotRepository = {
        upsertMany: async (inputs) => { for (const input of inputs) written.set(`${input.indicatorDefinitionId}@${input.candleId}`, input.values); },
      };
      const result = await new CalculateTechnicalIndicators(candleRepository, definitionRepository, snapshotRepository)
        .execute({ instrumentId: "instrument-1", timeframe: "1m", since, warmupBars });
      return { result, written, calls };
    }

    // Equal to the 1e-6 the production check used; Bollinger can differ by one 1e-8 rounding step.
    function differences(a: Map<string, Record<string, unknown>>, b: Map<string, Record<string, unknown>>): string[] {
      const out: string[] = [];
      for (const [key, left] of a) {
        const right = b.get(key);
        if (!right) { out.push(`${key} missing`); continue; }
        for (const field of Object.keys(left)) {
          const x = left[field]; const y = right[field];
          const same = typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-6 : x === y;
          if (!same) out.push(`${key}.${field}: ${String(x)} vs ${String(y)}`);
        }
      }
      for (const key of b.keys()) if (!a.has(key)) out.push(`${key} extra`);
      return out;
    }

    it("writes the same values as the whole-series run, from a fraction of the bars", async () => {
      const whole = await run(undefined);
      const bounded = await run(1500);

      expect(whole.calls.listCompleted).toBe(1);
      expect(whole.result.candlesRead).toBe(4000);
      // Bounded: the window read, never the whole series, and only what was asked for.
      expect(bounded.calls.listCompleted).toBe(0);
      expect(bounded.calls.window).toEqual([{ since, warmupBars: 1500 }]);
      expect(bounded.result.candlesRead).toBe(1000 + 1500);
      // Everything the whole-series run wrote is still there, with the same numbers.
      expect(whole.written.size).toBeGreaterThan(5000);
      expect(differences(whole.written, bounded.written)).toEqual([]);
    });

    it("is not equivalent when the warm-up is shorter than a VWAP session, so the check above has teeth", async () => {
      const whole = await run(undefined);
      const tooShort = await run(30);

      const mismatches = differences(whole.written, tooShort.written);
      expect(mismatches.some((line) => line.startsWith("VWAP"))).toBe(true);
    });

    it("needs `since` to know where the window is", async () => {
      const candleRepository: CandleRepository = {
        upsert: async () => { throw new Error("not used"); },
        findByKey: async () => null,
        listIncomplete: async () => [],
        listCompleted: async () => series,
        listCompletedWindow: async () => series,
      };
      const useCase = new CalculateTechnicalIndicators(candleRepository, { ensure: async () => { throw new Error("not reached"); } }, { upsertMany: async () => undefined });

      await expect(useCase.execute({ instrumentId: "instrument-1", timeframe: "1m", warmupBars: 5000 })).rejects.toThrow(/since/);
    });

    it("refuses, rather than quietly reading everything, on a repository that cannot bound the read", async () => {
      await expect(run(5000, false)).rejects.toThrow(/cannot read a bounded window/);
    });
  });
});
