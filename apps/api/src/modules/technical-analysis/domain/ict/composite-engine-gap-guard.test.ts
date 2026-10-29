import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { XAUUSD_OANDA_PROFILE } from "../../../platform/calendar/instrument-profile.js";
import type { CausalCandle } from "./causal-pivot.js";
import { IctCompositeEngine } from "./composite-engine.js";
import { computeIctConfigHash, defaultIctEngineConfig, type IctStateCompositeSnapshot } from "./config.js";
import { GOLD_RECOVERY_BARS, ictGapGuardFor } from "./series-gaps.js";

/**
 * A synthetic gold 15m series on the real calendar: sessions roll at 18:00 New York (23:00 UTC in January), there is a daily break at
 * 22:00-22:55 UTC, and nothing trades from Friday 22:00 to Sunday 23:00. Prices are a deterministic mix of waves and noise, so there
 * are plenty of swing pivots. Mon 2026-01-12 to Thu 2026-01-15 is four sessions, named by their New York date.
 */
function goldSeries(skip: (slot: Date) => boolean = () => false): CausalCandle[] {
  const candles: CausalCandle[] = [];
  let seed = 7;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let previousClose = 4000;
  let n = 0;
  for (let t = Date.parse("2026-01-11T23:00:00Z"); t < Date.parse("2026-01-15T22:00:00Z"); t += 15 * 60_000) {
    const slot = new Date(t);
    if (!XAUUSD_OANDA_PROFILE.isSessionActive(slot)) continue;
    n += 1;
    const close = 4000 + 14 * Math.sin(n / 14) + 6 * Math.sin(n / 3) + (noise() - 0.5) * 5;
    const wickUp = noise() * 2.2;
    const wickDown = noise() * 2.2;
    if (!skip(slot)) {
      candles.push({
        id: `bar-${n}`,
        openTime: slot,
        open: previousClose,
        high: Math.max(previousClose, close) + wickUp,
        low: Math.min(previousClose, close) - wickDown,
        close,
        volume: 0,
      });
    }
    previousClose = close;
  }
  return candles;
}

const holeFrom = (fromIso: string, toIso: string) => (slot: Date): boolean => slot >= new Date(fromIso) && slot < new Date(toIso);
const goldGuard = ictGapGuardFor("XAU_USD", "15m");

function run(candles: readonly CausalCandle[], guarded: boolean): IctStateCompositeSnapshot[] {
  const engine = new IctCompositeEngine(defaultIctEngineConfig, XAUUSD_OANDA_PROFILE, guarded ? goldGuard : null);
  return candles.map((_, i) => engine.processCandle(candles, i));
}

/**
 * The snapshot as it is stored (JSON, which is what drops the closure `bias.dealingRange.isPremium`, a fresh function object per run), without
 * the only two fields the guard is allowed to add or change when nothing is wrong.
 */
const stored = (snapshot: IctStateCompositeSnapshot): unknown => {
  const { configHash: _configHash, dataGap: _dataGap, ...rest } = snapshot;
  return JSON.parse(JSON.stringify(rest));
};

const indexAt = (candles: readonly CausalCandle[], iso: string): number => candles.findIndex((candle) => candle.openTime.getTime() === Date.parse(iso));
const anyIncomplete = (snapshots: readonly IctStateCompositeSnapshot[]): boolean => snapshots.some((snapshot) => Object.values(snapshot.coverage).includes("INCOMPLETE"));

describe("the ICT engine with a data-gap guard (gold)", () => {
  it("changes nothing on a complete series: every stored field of every snapshot equals the unguarded engine's", () => {
    const candles = goldSeries();
    const guarded = run(candles, true);
    const unguarded = run(candles, false);

    expect(candles.length).toBeGreaterThan(300);
    guarded.forEach((snapshot, i) => expect(stored(snapshot)).toEqual(stored(unguarded[i]!)));
    expect(guarded.every((snapshot) => snapshot.dataGap === null)).toBe(true);
    expect(anyIncomplete(guarded)).toBe(false);
  });

  it("tolerates a hole shorter than the threshold", () => {
    // thirty minutes in the middle of Tuesday: two bars, under the sixty-minute threshold
    const guarded = run(goldSeries(holeFrom("2026-01-13T14:00:00Z", "2026-01-13T14:30:00Z")), true);

    expect(anyIncomplete(guarded)).toBe(false);
    expect(guarded.every((snapshot) => snapshot.dataGap === null)).toBe(true);
  });

  describe("a four-hour hole in the middle of Tuesday's session", () => {
    const candles = goldSeries(holeFrom("2026-01-13T14:00:00Z", "2026-01-13T18:00:00Z"));
    const guarded = run(candles, true);
    const firstAfter = indexAt(candles, "2026-01-13T18:00:00Z");

    it("is found, and the bar before it is untouched", () => {
      expect(firstAfter).toBeGreaterThan(0);
      expect(guarded[firstAfter - 1]!.dataGap).toBeNull();
      expect(guarded[firstAfter - 1]!.coverage.structure).toBe("COMPLETE");
      expect(guarded[firstAfter]!.dataGap).toMatchObject({ missingMinutes: 240 });
    });

    it("marks structure and zones INCOMPLETE for the recovery window and then clears them", () => {
      expect(GOLD_RECOVERY_BARS).toBe(36);
      for (let i = firstAfter; i < firstAfter + 36; i += 1) {
        expect(guarded[i]!.coverage.structure).toBe("INCOMPLETE");
        expect(guarded[i]!.coverage.zones).toBe("INCOMPLETE");
      }
      expect(guarded[firstAfter + 36]!.coverage.structure).toBe("COMPLETE");
      expect(guarded[firstAfter + 36]!.coverage.zones).toBe("COMPLETE");
    });

    it("withholds the session levels for the hole's own session and the next one, whose prior day it is", () => {
      const sameSession = guarded[firstAfter + 2]!;
      expect(sameSession.sessionLevels.levels).toBeNull();
      expect(sameSession.coverage.sessionLevels).toBe("INCOMPLETE");

      const nextSessionOpen = guarded[indexAt(candles, "2026-01-13T23:00:00Z")]!;
      expect(nextSessionOpen.sessionLevels.levels).toBeNull();
      expect(nextSessionOpen.coverage.sessionLevels).toBe("INCOMPLETE");
    });

    it("gives the levels back once the hole's session is no longer the prior one", () => {
      const twoSessionsLater = guarded[indexAt(candles, "2026-01-14T23:00:00Z")]!;
      expect(twoSessionsLater.sessionLevels.levels).not.toBeNull();
      expect(twoSessionsLater.coverage.sessionLevels).toBe("COMPLETE");
      expect(twoSessionsLater.dataGap).toBeNull();
    });

    it("does not touch the levels before the hole", () => {
      const beforeHole = guarded[indexAt(candles, "2026-01-13T13:45:00Z")]!;
      expect(beforeHole.sessionLevels.levels).not.toBeNull();
      expect(beforeHole.coverage.sessionLevels).toBe("COMPLETE");
    });
  });

  describe("the unguarded engine and the cache identity", () => {
    it("is exactly the engine it always was when no guard is passed", () => {
      const candles = goldSeries(holeFrom("2026-01-13T14:00:00Z", "2026-01-13T18:00:00Z")).slice(0, 150);
      const plainEngine = new IctCompositeEngine(defaultIctEngineConfig, XAUUSD_OANDA_PROFILE);
      const plain = candles.map((_, i) => plainEngine.processCandle(candles, i));
      const explicitNull = run(candles, false);

      explicitNull.forEach((snapshot, i) => expect(JSON.parse(JSON.stringify(snapshot))).toEqual(JSON.parse(JSON.stringify(plain[i]))));
      expect(anyIncomplete(plain)).toBe(false);
      expect("dataGap" in plain[0]!).toBe(false);
    });

    it("keeps the hash every instrument without a guard always had", () => {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(defaultIctEngineConfig).sort()) normalized[key] = (defaultIctEngineConfig as unknown as Record<string, unknown>)[key];
      const originalAlgorithm = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

      expect(computeIctConfigHash(defaultIctEngineConfig)).toBe(originalAlgorithm);
      expect(computeIctConfigHash(defaultIctEngineConfig, null)).toBe(originalAlgorithm);
    });

    it("gives a guarded engine its own identity, and each timeframe its own", () => {
      const plain = computeIctConfigHash(defaultIctEngineConfig);
      const gold15 = computeIctConfigHash(defaultIctEngineConfig, goldGuard);
      const gold5 = computeIctConfigHash(defaultIctEngineConfig, ictGapGuardFor("XAU_USD", "5m"));

      expect(gold15).not.toBe(plain);
      expect(gold5).not.toBe(gold15);
      expect(new IctCompositeEngine(defaultIctEngineConfig, XAUUSD_OANDA_PROFILE, goldGuard).processCandle(goldSeries(), 5).configHash).toBe(gold15);
    });
  });
});
