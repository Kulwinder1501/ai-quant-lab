import { describe, expect, it } from "vitest";
import { simpleRsi } from "./simple-rsi.js";

/** 15 closes yields the 14 changes one RSI period needs. */
function closesFrom(start: number, changes: readonly number[]): number[] {
  const closes = [start];
  for (const change of changes) closes.push(closes[closes.length - 1] + change);
  return closes;
}

describe("simpleRsi", () => {
  it("reports nothing until a full period of changes exists", () => {
    expect(simpleRsi([])).toBeNull();
    expect(simpleRsi([100])).toBeNull();
    // 14 closes is only 13 changes -- one short.
    expect(simpleRsi(Array.from({ length: 14 }, (_, index) => 100 + index))).toBeNull();
    expect(simpleRsi(Array.from({ length: 15 }, (_, index) => 100 + index))).not.toBeNull();
  });

  it("computes the ratio of average gain to average loss", () => {
    // Seven +2 gains and seven -1 losses: average gain 1.0, average loss 0.5, so
    // RS is 2 and RSI is 100 - 100/3.
    const closes = closesFrom(100, [2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1]);
    expect(closes).toHaveLength(15);
    expect(simpleRsi(closes)).toBeCloseTo(66.6667, 4);
  });

  it("pins the extremes where there is nothing to divide by", () => {
    const onlyGains = Array.from({ length: 15 }, (_, index) => 100 + index);
    const onlyLosses = Array.from({ length: 15 }, (_, index) => 100 - index);

    expect(simpleRsi(onlyGains)).toBe(100);
    expect(simpleRsi(onlyLosses)).toBe(0);
    // A flat series has no gain and no loss, so neither extreme is meaningful.
    expect(simpleRsi(Array.from({ length: 15 }, () => 100))).toBe(50);
  });

  it("reads only the most recent period, ignoring older history", () => {
    const recent = closesFrom(100, [2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1]);
    const withPrefix = [500, 10, 900, ...recent];

    expect(simpleRsi(withPrefix)).toBeCloseTo(simpleRsi(recent)!, 10);
  });

  it("stays inside the 0-100 band it is defined on", () => {
    const swings = closesFrom(100, [9, -4, 1, -7, 12, -2, 3, -11, 6, -1, 8, -5, 2, -3]);

    const rsi = simpleRsi(swings)!;
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
  });
});
