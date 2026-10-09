import { describe, expect, it } from "vitest";
import type { CausalCandle } from "./causal-pivot.js";
import { IctCompositeEngine } from "./composite-engine.js";
import { defaultIctEngineConfig } from "./config.js";

/**
 * Whole-engine causality: a snapshot for bar k may depend on bars 0..k and on nothing after.
 *
 * `IctCompositeEngine.processCandle` is handed the FULL candle array and an index, so a detector that
 * reads `candles[k + 1]` would compile, run and silently look ahead. The only way to catch that is
 * behavioural: change the future and see whether the past moves. This covers the v3 additions (the
 * ATR-gated zone ledger and the MSS tracker) together with everything they feed.
 */

const BAR_MS = 15 * 60_000;
const BARS_PER_DAY = 25; // 09:15..15:30 IST
const DAYS = 12;

/** Small deterministic generator so the series, and any failure, reproduces exactly. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A random walk with regime changes and occasional displacement bars, so sweeps, shifts, gaps and
 * blocks all actually occur. A flat series would pass every causality test vacuously.
 */
function buildSeries(seed: number): CausalCandle[] {
  const random = lcg(seed);
  const candles: CausalCandle[] = [];
  let price = 22_000;
  let drift = 0;
  for (let day = 0; day < DAYS; day += 1) {
    // 03:45Z is 09:15 IST. Skip weekends crudely by stepping calendar days from a Monday.
    const dayStart = Date.UTC(2025, 2, 3 + day + Math.floor(day / 5) * 2, 3, 45, 0);
    for (let bar = 0; bar < BARS_PER_DAY; bar += 1) {
      if (random() < 0.12) drift = (random() - 0.5) * 40;
      const open = price + (bar === 0 ? (random() - 0.5) * 60 : 0);
      const displacement = random() < 0.1 ? (random() - 0.5) * 260 : 0;
      const close = open + drift + (random() - 0.5) * 50 + displacement;
      const wickUp = random() * (random() < 0.15 ? 90 : 25);
      const wickDown = random() * (random() < 0.15 ? 90 : 25);
      const openTime = new Date(dayStart + bar * BAR_MS);
      candles.push({
        id: `c-${seed}-${day}-${bar}`,
        openTime,
        open,
        high: Math.max(open, close) + wickUp,
        low: Math.min(open, close) - wickDown,
        close,
        volume: 1000,
      });
      price = close;
    }
  }
  return candles;
}

function runEngine(candles: readonly CausalCandle[], upTo: number): string[] {
  const engine = new IctCompositeEngine(defaultIctEngineConfig);
  const out: string[] = [];
  for (let i = 0; i <= upTo; i += 1) {
    out.push(JSON.stringify(engine.processCandle(candles, i, i % 7 < 4 ? "BULLISH" : "BEARISH")));
  }
  return out;
}

describe("IctCompositeEngine causality (ict-state-v3)", () => {
  const series = buildSeries(20260101);

  it("exercises the new detectors on this series (guards against a vacuous test)", () => {
    const snapshots = runEngine(series, series.length - 1).map((s) => JSON.parse(s) as {
      mss?: unknown;
      zones: { activeFvgs: unknown[]; activeObs: unknown[] };
    });
    expect(snapshots.some((s) => s.mss)).toBe(true);
    expect(snapshots.some((s) => s.zones.activeFvgs.length > 0)).toBe(true);
    expect(snapshots.some((s) => s.zones.activeObs.length > 0)).toBe(true);
  });

  it("is prefix invariant: processing a truncated series yields identical snapshots", () => {
    const full = runEngine(series, series.length - 1);
    for (const cut of [60, 137, 211]) {
      // The truncated run is given ONLY the first cut + 1 bars, so there is nothing to peek at.
      const truncated = runEngine(series.slice(0, cut + 1), cut);
      expect(truncated[cut]).toBe(full[cut]);
    }
  });

  it("is future-perturbation invariant: rewriting every later bar changes nothing earlier", () => {
    const base = runEngine(series, series.length - 1);
    const rewrittenFuture = (cut: number): CausalCandle[] => {
      const random = lcg(99 + cut);
      return series.map((c, index) => {
        if (index <= cut) return c;
        const shift = (random() - 0.5) * 400;
        return { ...c, open: c.open + shift, close: c.close + shift, high: c.high + shift + 150, low: c.low + shift - 150 };
      });
    };
    for (const cut of [45, 120, 199, 260]) {
      const perturbed = runEngine(rewrittenFuture(cut), cut);
      for (let i = 0; i <= cut; i += 1) {
        expect(perturbed[i], `snapshot ${i} moved when bars after ${cut} were rewritten`).toBe(base[i]);
      }
    }
  });
});
