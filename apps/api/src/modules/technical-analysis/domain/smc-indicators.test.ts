import { describe, expect, it } from "vitest";
import { TechnicalIndicatorEngine } from "./technical-indicator-engine.js";
import { defaultIndicatorDefinitions } from "./technical-indicator.js";
import type { IndicatorCandle, IndicatorPoint } from "./technical-indicator.js";

/**
 * Smart-money-concept indicators: BOS, CHOCH, FVG, LIQUIDITY_SWEEP, ORDER_BLOCK and
 * EQUILIBRIUM_ZONE.
 *
 * These shipped with no tests, and three of them read the future. FVG detected a three-bar
 * gap using bar i and stamped it on bar i-1. EQUILIBRIUM_ZONE published a zone on the same
 * bar whose swing had been confirmed from the following pivotLength bars. ORDER_BLOCK
 * measured displacement against a mean seeded from the series' first fifty candles, wherever
 * it happened to be scoring. The sweep below is the check that found them.
 */

const SMC_CODES = ["FVG", "BOS", "CHOCH", "LIQUIDITY_SWEEP", "ORDER_BLOCK", "EQUILIBRIUM_ZONE"] as const;

type Row = [open: number, high: number, low: number, close: number];

function series(rows: readonly Row[]): IndicatorCandle[] {
  return rows.map(([open, high, low, close], index) => ({
    id: "c" + index,
    openTime: new Date(Date.UTC(2026, 0, 1, 0, index)),
    open, high, low, close, volume: 1000 + index,
  }));
}

/** Trends up, breaks structure, sweeps, gaps and reverses, so each rule has something to fire on. */
const MARKET: readonly Row[] = [
  [100, 105,  95, 103], [103, 107,  99, 101], [101, 110, 100, 108], [108, 112, 103, 104],
  [104, 115, 103, 113], [113, 140, 110, 137], [137, 139, 118, 120], [120, 122, 108, 110],
  [110, 114, 104, 112], [112, 113, 102, 104], [104, 111, 101, 109], [109, 145, 107, 142],
  [142, 143, 112, 114], [114, 116, 101, 103], [103, 109,  99, 107], [107, 108,  97,  99],
  [ 99, 130,  98, 128], [128, 150, 126, 147], [147, 160, 145, 158], [158, 162, 150, 152],
  [152, 164, 151, 162], [162, 166, 154, 156], [156, 158, 120, 124], [124, 135, 115, 132],
  [132, 133, 113, 116], [116, 180, 114, 178], [178, 182, 165, 168], [168, 178, 158, 160],
  [160, 176, 156, 174], [174, 175, 154, 156], [156, 172, 152, 170], [170, 171, 150, 152],
  [152, 168, 148, 166], [166, 167, 146, 148], [148, 164, 144, 162],
];

const engine = new TechnicalIndicatorEngine();

function definitionFor(code: string) {
  const definition = defaultIndicatorDefinitions.find((candidate) => candidate.code === code);
  if (!definition) throw new Error(code + " is not a registered indicator definition.");
  return definition;
}

function valuesByCandle(points: IndicatorPoint[]): Map<string, string> {
  return new Map(points.map((point) => [point.candleId, JSON.stringify(point.values)]));
}

function barIndexOf(candleId: string): number {
  return Number(candleId.slice(1));
}

describe("SMC indicators - point in time", () => {
  // The heart of it: edit a bar, and nothing before it may move. An indicator that fails
  // this is unusable as a model feature however good it looks on a chart.
  for (const code of SMC_CODES) {
    it(code + " never revises an earlier bar when a later bar changes", () => {
      const definition = definitionFor(code);
      const original = valuesByCandle(engine.calculate(series(MARKET), definition));

      for (const mutateAt of [26, 28, 30, 32]) {
        const altered = MARKET.map((row) => [...row] as Row);
        altered[mutateAt] = [90, 92, 60, 62];
        const mutated = valuesByCandle(engine.calculate(series(altered), definition));

        for (const [candleId, value] of original) {
          if (barIndexOf(candleId) < mutateAt) {
            expect(
              mutated.get(candleId),
              code + " changed " + candleId + " after editing bar " + mutateAt,
            ).toBe(value);
          }
        }
      }
    });
  }

  it("fires on this fixture, so the sweep above is not vacuous", () => {
    // Without this, an indicator that silently emits nothing would pass every check here.
    const emitting = SMC_CODES.filter(
      (code) => engine.calculate(series(MARKET), definitionFor(code)).length > 0,
    );

    expect(emitting).toContain("FVG");
    expect(emitting).toContain("BOS");
    expect(emitting).toContain("ORDER_BLOCK");
    expect(emitting).toContain("EQUILIBRIUM_ZONE");
    expect(emitting).toContain("LIQUIDITY_SWEEP");
  });
});

describe("FVG", () => {
  it("publishes the gap on the bar that completes it, not the middle bar", () => {
    // Bar 2's low (120) sits above bar 0's high (105). The observation cannot exist before
    // bar 2 closes, so it belongs to bar 2; stamping it on bar 1 made bar 1 depend on bar 2.
    const rows: Row[] = [[100, 105, 95, 103], [110, 118, 108, 116], [125, 130, 120, 128]];

    const points = engine.calculate(series(rows), definitionFor("FVG"));

    expect(points).toHaveLength(1);
    expect(points[0]!.candleId).toBe("c2");
    expect(points[0]!.values).toMatchObject({ type: "BULLISH", top: 120, bottom: 105 });
  });

  it("still records how far back the zone sits, so a chart can draw it in place", () => {
    const rows: Row[] = [[100, 105, 95, 103], [110, 118, 108, 116], [125, 130, 120, 128]];

    const [point] = engine.calculate(series(rows), definitionFor("FVG"));

    expect(point!.values.gapBarOffset).toBe(1);
  });

  it("reports a bearish gap the same way", () => {
    const rows: Row[] = [[128, 130, 120, 125], [116, 118, 108, 110], [103, 105, 95, 100]];

    const [point] = engine.calculate(series(rows), definitionFor("FVG"));

    expect(point!.candleId).toBe("c2");
    expect(point!.values).toMatchObject({ type: "BEARISH", top: 120, bottom: 105 });
  });

  it("finds no gap when the bars overlap", () => {
    const rows: Row[] = [[100, 110, 95, 105], [104, 112, 99, 108], [106, 115, 100, 112]];

    expect(engine.calculate(series(rows), definitionFor("FVG"))).toEqual([]);
  });
});

describe("EQUILIBRIUM_ZONE", () => {
  it("still publishes a zone once its swings are confirmed", () => {
    // The look-ahead fix must not have silenced it, which deleting the emission would also
    // have achieved.
    const points = engine.calculate(series(MARKET), definitionFor("EQUILIBRIUM_ZONE"));

    expect(points.length).toBeGreaterThan(0);
    const values = points[0]!.values as unknown as { top: number; bottom: number; equilibrium: number };
    expect(values.top).toBeGreaterThan(values.bottom);
    expect(values.equilibrium).toBeCloseTo((values.top + values.bottom) / 2, 2);
  });
});

describe("ORDER_BLOCK", () => {
  it("measures displacement only against bars already seen", () => {
    // A late outsized bar must not retroactively make earlier bars ordinary by lifting the
    // average they were compared against.
    const definition = definitionFor("ORDER_BLOCK");
    const original = valuesByCandle(engine.calculate(series(MARKET), definition));

    const altered = MARKET.map((row) => [...row] as Row);
    altered[33] = [100, 400, 50, 390];
    const mutated = valuesByCandle(engine.calculate(series(altered), definition));

    for (const [candleId, value] of original) {
      if (barIndexOf(candleId) < 33) expect(mutated.get(candleId)).toBe(value);
    }
  });
});

describe("registered definitions", () => {
  it("every SMC code the engine handles is registered and callable", () => {
    for (const code of SMC_CODES) {
      const definition = definitionFor(code);
      expect(definition.algorithmVersion).toBeTruthy();
      // A pivot-based indicator with no pivotLength parameter would throw only here.
      expect(() => engine.calculate(series(MARKET), definition)).not.toThrow();
    }
  });
});
