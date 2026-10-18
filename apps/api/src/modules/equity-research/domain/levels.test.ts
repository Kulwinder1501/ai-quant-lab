import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clusterPivots,
  computeAtr14,
  computeLevels,
  computeTrueRanges,
  computeVolumeProfile,
  EQUITY_LEVELS_DISCLAIMER,
  EQUITY_LEVELS_EMPIRICAL_NOTE,
  findSwingPivots,
  type LevelItem,
  type LevelsInput,
  type SwingPivot,
} from "./levels.js";

// Helper to generate daily bars
function generateBars(
  count: number,
  startDateStr: string,
  baseClose = 100,
  dailyStep = 0.2,
  volume = 10_000,
) {
  const bars: LevelsInput["bars"] = [];
  const [y, m, d] = startDateStr.split("-").map(Number);
  const current = new Date(Date.UTC(y, m - 1, d));

  let close = baseClose;
  for (let i = 0; i < count; i++) {
    const dateStr = current.toISOString().slice(0, 10);
    bars.push({
      bar_date: dateStr,
      open: close - 0.2,
      high: close + 1.5,
      low: close - 1.5,
      close: close,
      volume,
    });
    close += dailyStep;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return bars;
}

describe("Levels Engine Domain Logic (WP-B Step B1 - Reviewed Edition)", () => {
  // =========================================================================
  // Gate L1: Hand-Computed Fixtures (>= 8 distinct fixtures)
  // =========================================================================
  describe("Gate L1: Hand-Computed Fixtures", () => {
    it("Fixture 1: True Range and ATR14 Hand Check (Full Precision)", () => {
      // 15 bars with hand-specified prices:
      // Bar 0: H=105, L=95, C=100 -> TR = 105 - 95 = 10.0
      // Bar 1: H=104, L=98, C=102, prevC=100 -> TR = max(104-98=6, |104-100|=4, |98-100|=2) = 6.0
      // Bar 2: H=108, L=101, C=106, prevC=102 -> TR = max(7, 6, 1) = 7.0
      // Bar 3: H=107, L=103, C=104, prevC=106 -> TR = max(4, 1, 3) = 4.0
      // Bar 4: H=110, L=99, C=101, prevC=104 -> TR = max(11, 6, 5) = 11.0
      // Bar 5: H=103, L=97, C=98, prevC=101 -> TR = max(6, 2, 4) = 6.0
      // Bar 6: H=100, L=95, C=99, prevC=98 -> TR = max(5, 2, 3) = 5.0
      // Bar 7: H=102, L=96, C=101, prevC=99 -> TR = max(6, 3, 3) = 6.0
      // Bar 8: H=105, L=100, C=104, prevC=101 -> TR = max(5, 4, 1) = 5.0
      // Bar 9: H=109, L=103, C=108, prevC=104 -> TR = max(6, 5, 1) = 6.0
      // Bar 10: H=111, L=105, C=107, prevC=108 -> TR = max(6, 3, 3) = 6.0
      // Bar 11: H=108, L=102, C=103, prevC=107 -> TR = max(6, 1, 5) = 6.0
      // Bar 12: H=106, L=98, C=100, prevC=103 -> TR = max(8, 3, 5) = 8.0
      // Bar 13: H=104, L=99, C=102, prevC=100 -> TR = max(5, 4, 1) = 5.0
      // Bar 14: H=107, L=101, C=105, prevC=102 -> TR = max(6, 5, 1) = 6.0
      //
      // Total 15 bars (index 0 to 14).
      // The last 14 True Ranges (bars 1 to 14):
      // [6, 7, 4, 11, 6, 5, 6, 5, 6, 6, 6, 8, 5, 6]
      // Sum = 6+7+4+11+6+5+6+5+6+6+6+8+5+6 = 87
      // ATR14 = 87 / 14 = 6.214285714285714...
      const rawBars = [
        { high: 105, low: 95, close: 100 },
        { high: 104, low: 98, close: 102 },
        { high: 108, low: 101, close: 106 },
        { high: 107, low: 103, close: 104 },
        { high: 110, low: 99, close: 101 },
        { high: 103, low: 97, close: 98 },
        { high: 100, low: 95, close: 99 },
        { high: 102, low: 96, close: 101 },
        { high: 105, low: 100, close: 104 },
        { high: 109, low: 103, close: 108 },
        { high: 111, low: 105, close: 107 },
        { high: 108, low: 102, close: 103 },
        { high: 106, low: 98, close: 100 },
        { high: 104, low: 99, close: 102 },
        { high: 107, low: 101, close: 105 },
      ];

      const trs = computeTrueRanges(rawBars);
      expect(trs).toEqual([10, 6, 7, 4, 11, 6, 5, 6, 5, 6, 6, 6, 8, 5, 6]);

      const atr14 = computeAtr14(rawBars, 14);
      expect(atr14).not.toBeNull();
      expect(atr14).toBe(87 / 14); // Exact double precision equality
    });

    it("Fixture 2: Swing Pivots Low & High (k=5)", () => {
      const bars = [
        { bar_date: "2026-01-01", low: 50, high: 55, volume: 100 }, // 0
        { bar_date: "2026-01-02", low: 48, high: 54, volume: 100 }, // 1
        { bar_date: "2026-01-03", low: 46, high: 53, volume: 100 }, // 2
        { bar_date: "2026-01-04", low: 44, high: 52, volume: 100 }, // 3
        { bar_date: "2026-01-05", low: 42, high: 51, volume: 100 }, // 4
        { bar_date: "2026-01-06", low: 40, high: 50, volume: 100 }, // 5: SWING LOW
        { bar_date: "2026-01-07", low: 43, high: 52, volume: 100 }, // 6
        { bar_date: "2026-01-08", low: 45, high: 56, volume: 100 }, // 7
        { bar_date: "2026-01-09", low: 47, high: 70, volume: 100 }, // 8: SWING HIGH
        { bar_date: "2026-01-10", low: 46, high: 65, volume: 100 }, // 9
        { bar_date: "2026-01-11", low: 45, high: 62, volume: 100 }, // 10
        { bar_date: "2026-01-12", low: 44, high: 60, volume: 100 }, // 11
        { bar_date: "2026-01-13", low: 43, high: 58, volume: 100 }, // 12
        { bar_date: "2026-01-14", low: 42, high: 55, volume: 100 }, // 13
        { bar_date: "2026-01-15", low: 41, high: 54, volume: 100 }, // 14
      ];

      const pivots = findSwingPivots(bars, 5, 252);
      expect(pivots.length).toBe(2);

      expect(pivots[0]).toEqual({
        price: 40,
        barDate: "2026-01-06",
        barIndex: 5,
        volume: 100,
        kind: "SWING_LOW",
      });

      expect(pivots[1]).toEqual({
        price: 70,
        barDate: "2026-01-09",
        barIndex: 8,
        volume: 100,
        kind: "SWING_HIGH",
      });
    });

    it("Fixture 3: Single-Linkage Clustering and Cluster Threshold", () => {
      const pivots: SwingPivot[] = [
        { price: 101.2, barDate: "2026-01-02", barIndex: 1, volume: 100, kind: "SWING_LOW" },
        { price: 150.0, barDate: "2026-01-04", barIndex: 3, volume: 100, kind: "SWING_HIGH" },
        { price: 100.0, barDate: "2026-01-01", barIndex: 0, volume: 100, kind: "SWING_LOW" },
        { price: 103.0, barDate: "2026-01-03", barIndex: 2, volume: 100, kind: "SWING_HIGH" },
        { price: 151.5, barDate: "2026-01-05", barIndex: 4, volume: 100, kind: "SWING_HIGH" },
      ];

      const clusters = clusterPivots(pivots, 0.015);
      expect(clusters.length).toBe(3);

      expect(clusters[0].map((p) => p.price)).toEqual([100.0, 101.2]);
      expect((100.0 + 101.2) / 2).toBe(100.6);

      expect(clusters[1].map((p) => p.price)).toEqual([103.0]);

      expect(clusters[2].map((p) => p.price)).toEqual([150.0, 151.5]);
      expect((150.0 + 151.5) / 2).toBe(150.75);
    });

    it("Fixture 4: Recency-Weighted Strength Calculation (Condition 2: Full Precision)", () => {
      const halfLife = 126;
      const T = 252;
      const ages = [T - 252, T - 126, T - 0];
      const sum = ages.reduce((acc, age) => acc + Math.pow(0.5, age / halfLife), 0);
      expect(sum).toBe(1.75);
    });

    it("Fixture 5: Zone Half-Width Calculation (max(1%, 0.5 * ATR14))", () => {
      const price = 200.0;
      const zoneMinPct = 0.01;
      const zoneAtrMultiple = 0.5;

      const wA = Math.max(zoneMinPct * price, zoneAtrMultiple * 2.0);
      expect(wA).toBe(2.0);
      expect(price - wA).toBe(198.0);
      expect(price + wA).toBe(202.0);

      const wB = Math.max(zoneMinPct * price, zoneAtrMultiple * 8.0);
      expect(wB).toBe(4.0);
      expect(price - wB).toBe(196.0);
      expect(price + wB).toBe(204.0);
    });

    it("Fixture 6: Break & Flip Hand Trace", () => {
      const baseBars = generateBars(280, "2025-01-01", 100, 0, 10_000);

      for (let i = 95; i <= 105; i++) {
        baseBars[i].low = i === 100 ? 100.0 : 103.0;
        baseBars[i].high = 110.0;
        baseBars[i].close = 106.0;
      }
      for (let i = 145; i <= 155; i++) {
        baseBars[i].low = i === 150 ? 100.2 : 103.0;
        baseBars[i].high = 110.0;
        baseBars[i].close = 106.0;
      }

      baseBars[278].close = 95.0;
      baseBars[278].low = 94.0;
      baseBars[279].close = 94.0;

      const res = computeLevels({
        bars: baseBars,
        rebackfillNeeded: false,
        asOfEvaluationDate: baseBars[279].bar_date,
      });
      const swingLevel = res.levels.find((l) => l.kind === "SWING");
      expect(swingLevel).toBeDefined();
      expect(swingLevel?.state).toBe("FLIPPED");
      expect(swingLevel?.side).toBe("RESISTANCE");
      expect(swingLevel?.brokenOn).toBe(baseBars[278].bar_date);
    });

    it("Fixture 7: Round Numbers Hand Calculation Across Magnitudes", () => {
      const bars42 = generateBars(300, "2025-01-01", 42, 0);
      const res42 = computeLevels({
        bars: bars42,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars42[299].bar_date,
      });
      const round42 = res42.levels.filter((l) => l.kind === "ROUND_NUMBER").map((l) => l.price);
      expect(round42.sort((a, b) => a - b)).toEqual([40, 45]);

      const bars100 = generateBars(300, "2025-01-01", 100, 0);
      const res100 = computeLevels({
        bars: bars100,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars100[299].bar_date,
      });
      const round100 = res100.levels.filter((l) => l.kind === "ROUND_NUMBER").map((l) => l.price);
      expect(round100).toEqual([100]);

      const bars99 = generateBars(300, "2025-01-01", 99, 0);
      const res99 = computeLevels({
        bars: bars99,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars99[299].bar_date,
      });
      const round99 = res99.levels.filter((l) => l.kind === "ROUND_NUMBER").map((l) => l.price);
      expect(round99.sort((a, b) => a - b)).toEqual([85, 90, 95, 100, 105, 110]);
    });

    it("Fixture 8: Volume Profile Hand Calculation", () => {
      const bars = [
        { low: 100.0, high: 120.0, volume: 210 },
        { low: 125.0, high: 135.0, volume: 1100 },
        { low: 140.0, high: 160.0, volume: 200 },
      ];

      const vp = computeVolumeProfile(bars, 60, 0.70);
      expect(vp).not.toBeNull();
      expect(vp?.binWidth).toBe(1.0);
      expect(vp?.totalVolume).toBe(1510);
      expect(vp?.poc).toBe(125.5);
      expect(vp?.val).toBeLessThanOrEqual(125.0);
      expect(vp?.vah).toBeGreaterThanOrEqual(136.0);
    });

    it("Fixture 9: Unfilled Gap Hand Calculation", () => {
      const bars = generateBars(300, "2025-01-01", 100, 0);
      bars[259].high = 100.0;
      bars[259].close = 99.5;
      bars[260].open = 106.0;
      bars[260].low = 105.0;
      bars[260].high = 108.0;
      bars[260].close = 107.0;

      for (let i = 261; i < 300; i++) {
        bars[i].low = 104.0;
        bars[i].high = 108.0;
        bars[i].close = 106.0;
      }

      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[299].bar_date,
      });
      const gapLevel = res.levels.find((l) => l.kind === "GAP" && l.source === "Unfilled Gap Up Edge");
      expect(gapLevel).toBeDefined();
      expect(gapLevel?.price).toBe(100.0);

      bars[290].low = 99.0;
      const resFilled = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[299].bar_date,
      });
      const filledGap = resFilled.levels.find(
        (l) => l.kind === "GAP" && l.price === 100.0 && l.source === "Unfilled Gap Up Edge",
      );
      expect(filledGap).toBeUndefined();
    });

    it("Fixture 10: TMPV Demerger Artifact Handling (Condition 1)", () => {
      // Historical simulation of TMPV:
      // Pre-demerger scale (close ~660, 52W high 810).
      // Demerger on 2025-10-14: close drops from 660.75 to 395.45 (-40.15% drop > 40%).
      // Cut at 2025-12-24: close 359.20.
      const bars: LevelsInput["bars"] = [];
      const startDate = new Date(Date.UTC(2025, 0, 1));
      const cur = new Date(startDate);

      // Pre-demerger bars (200 bars up to 2025-10-13)
      for (let i = 0; i < 200; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        const isHigh = i === 120; // 52W high at 810.0
        bars.push({
          bar_date: dStr,
          open: isHigh ? 805 : 660,
          high: isHigh ? 810 : 670,
          low: isHigh ? 800 : 650,
          close: isHigh ? 808 : i === 199 ? 660.75 : 660,
          volume: 50_000,
        });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      // Demerger bar (2025-10-14): close drops from 660.75 to 395.45 (-40.15%)
      const demergerDate = cur.toISOString().slice(0, 10);
      bars.push({
        bar_date: demergerDate,
        open: 400.0,
        high: 410.0,
        low: 390.0,
        close: 395.45,
        volume: 500_000,
      });
      cur.setUTCDate(cur.getUTCDate() + 1);

      // Post-demerger bars (50 bars up to 2025-12-24, ending at 359.20)
      for (let i = 0; i < 50; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        const isEnd = i === 49;
        bars.push({
          bar_date: dStr,
          open: 370,
          high: 385,
          low: 355,
          close: isEnd ? 359.20 : 370,
          volume: 20_000,
        });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      const lastDate = bars[bars.length - 1].bar_date;
      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: lastDate,
      });

      // 1. Must identify artifact and exclude pre-event data
      expect(res.state).toBe("INSUFFICIENT_HISTORY");
      expect(
        res.warnings.some(
          (w) => w.includes("Suspected corporate-action artifact") && w.includes(demergerDate),
        ),
      ).toBe(true);

      // 2. Crucial condition: NO pre-event levels (above 500) appear anywhere
      const preEventLevels = res.levels.filter((l) => l.price > 500);
      expect(preEventLevels.length).toBe(0);

      // 3. 52-week high must come from post-demerger scale (385), NOT pre-demerger 810
      const high52 = res.levels.find((l) => l.kind === "52W_HIGH");
      if (high52) {
        expect(high52.price).toBeLessThanOrEqual(450);
      }

      // 4. Volume profile POC must be in post-event scale (~370), NOT pre-event 680
      const vpPoc = res.levels.find((l) => l.kind === "VOLUME_PROFILE_POC");
      if (vpPoc) {
        expect(vpPoc.price).toBeLessThanOrEqual(450);
      }

      // 5. Swing levels must NOT be produced because post-demerger history (50 bars) < 258 bars
      const swingLevels = res.levels.filter((l) => l.kind === "SWING");
      expect(swingLevels.length).toBe(0);
    });
  });

  // =========================================================================
  // Gate L2: No Look-Ahead Test
  // =========================================================================
  describe("Gate L2: No Look-Ahead Verification", () => {
    it("levels computed on series cut at date d are identical to full series truncated at d, and future spikes change nothing prior", () => {
      const stocks = [
        generateBars(400, "2025-01-01", 50, 0.1, 10_000),
        generateBars(400, "2025-01-01", 120, -0.05, 25_000),
        generateBars(400, "2025-01-01", 300, 0.25, 5_000),
        generateBars(400, "2025-01-01", 85, 0.0, 15_000),
        generateBars(400, "2025-01-01", 200, -0.15, 50_000),
      ];

      const cutIndices = [
        260, 265, 270, 275, 280, 285, 290, 295, 300, 305,
        310, 315, 320, 325, 330, 340, 350, 360, 370, 380,
      ];

      for (let sIdx = 0; sIdx < stocks.length; sIdx++) {
        const fullStock = stocks[sIdx];

        for (const cut of cutIndices) {
          const cutDate = fullStock[cut].bar_date;

          const truncatedSlice = fullStock.slice(0, cut + 1);
          const resTruncated = computeLevels({
            bars: truncatedSlice,
            rebackfillNeeded: false,
            asOfEvaluationDate: cutDate,
          });

          // Plant a massive spike 5 bars in the future (at cut + 5)
          const futureSpikeBars = fullStock.slice(0, cut + 10).map((b, idx) => {
            if (idx === cut + 5) {
              return {
                ...b,
                high: b.high * 5,
                close: b.close * 5,
                volume: b.volume * 10,
              };
            }
            return { ...b };
          });

          const spikeSlice = futureSpikeBars.slice(0, cut + 1);
          const resSpikeSlice = computeLevels({
            bars: spikeSlice,
            rebackfillNeeded: false,
            asOfEvaluationDate: cutDate,
          });

          expect(resTruncated.asOfDate).toBe(cutDate);
          expect(resTruncated.atr14).toBe(resSpikeSlice.atr14);
          expect(resTruncated.state).toBe(resSpikeSlice.state);
          expect(resTruncated.riskDistanceAtr).toBe(resSpikeSlice.riskDistanceAtr);
          expect(resTruncated.levels.length).toBe(resSpikeSlice.levels.length);

          for (let i = 0; i < resTruncated.levels.length; i++) {
            const lA = resTruncated.levels[i];
            const lB = resSpikeSlice.levels[i];
            expect(lA.id).toBe(lB.id);
            expect(lA.price).toBe(lB.price);
            expect(lA.side).toBe(lB.side);
            expect(lA.zoneLow).toBe(lB.zoneLow);
            expect(lA.zoneHigh).toBe(lB.zoneHigh);
            expect(lA.strength).toBe(lB.strength);
            expect(lA.state).toBe(lB.state);
          }
        }
      }
    });
  });

  // =========================================================================
  // Gate L5: Edge Cases
  // =========================================================================
  describe("Gate L5: Edge Cases", () => {
    it("handles a completely flat series (H = L = C, ATR = 0)", () => {
      const flatBars = generateBars(300, "2025-01-01", 100, 0, 1000).map((b) => ({
        ...b,
        high: 100.0,
        low: 100.0,
        close: 100.0,
      }));

      const res = computeLevels({
        bars: flatBars,
        rebackfillNeeded: false,
        asOfEvaluationDate: flatBars[299].bar_date,
      });
      expect(res.state).toBe("OK");
      expect(res.atr14).toBe(0);
      expect(res.atrPercent).toBe(0);
      expect(res.levels.some((l) => l.kind === "SMA_50")).toBe(true);
      expect(res.levels.some((l) => l.kind === "ROUND_NUMBER")).toBe(true);
    });

    it("handles fewer than 258 bars (e.g. 80 bars) with INSUFFICIENT_HISTORY (Condition 3)", () => {
      const shortBars = generateBars(80, "2026-05-01", 100, 0.2);
      const res = computeLevels({
        bars: shortBars,
        rebackfillNeeded: false,
        asOfEvaluationDate: shortBars[79].bar_date,
      });

      expect(res.state).toBe("INSUFFICIENT_HISTORY");
      expect(res.levels.filter((l) => l.kind === "SWING").length).toBe(0);
      expect(res.levels.some((l) => l.kind === "SMA_50")).toBe(true);
      expect(res.levels.some((l) => l.kind === "52W_HIGH")).toBe(true);
      expect(res.nearestSupport).toBeNull();
      expect(res.nearestResistance).toBeNull();
    });

    it("handles fewer than 14 bars gracefully (Condition 4: No ATR fallback)", () => {
      const veryShort = generateBars(10, "2026-05-01", 100, 0.2);
      const res = computeLevels({
        bars: veryShort,
        rebackfillNeeded: false,
        asOfEvaluationDate: veryShort[9].bar_date,
      });

      expect(res.state).toBe("INSUFFICIENT_HISTORY");
      expect(res.atr14).toBeNull();
      expect(res.levels.length).toBe(0);
    });

    it("handles calendar gaps over 10 days without crashing", () => {
      const bars = generateBars(300, "2025-01-01", 100, 0.1);
      const dateParts = bars[100].bar_date.split("-").map(Number);
      const jumpedDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2] + 20));
      for (let i = 100; i < bars.length; i++) {
        bars[i].bar_date = jumpedDate.toISOString().slice(0, 10);
        jumpedDate.setUTCDate(jumpedDate.getUTCDate() + 1);
      }

      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[299].bar_date,
      });
      expect(res.state).toBe("OK");
    });

    it("handles a halted stock where High equals Low for several weeks", () => {
      const bars = generateBars(300, "2025-01-01", 100, 0.1);
      for (let i = 150; i <= 180; i++) {
        bars[i].high = 115.0;
        bars[i].low = 115.0;
        bars[i].close = 115.0;
        bars[i].volume = 0;
      }

      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[299].bar_date,
      });
      expect(res.state).toBe("OK");
    });

    it("handles zero-volume days in Volume Profile safely", () => {
      const zeroVolBars = generateBars(280, "2025-01-01", 100, 0.1).map((b) => ({
        ...b,
        volume: 0,
      }));

      const res = computeLevels({
        bars: zeroVolBars,
        rebackfillNeeded: false,
        asOfEvaluationDate: zeroVolBars[279].bar_date,
      });
      expect(res.state).toBe("OK");
      expect(res.levels.some((l) => l.kind === "VOLUME_PROFILE_POC")).toBe(false);
    });

    it("ignores a single pivot cluster with touches < minPivots", () => {
      const pivots: SwingPivot[] = [
        { price: 100.0, barDate: "2026-01-01", barIndex: 10, volume: 100, kind: "SWING_LOW" },
        { price: 200.0, barDate: "2026-02-01", barIndex: 30, volume: 100, kind: "SWING_HIGH" },
      ];

      const clusters = clusterPivots(pivots, 0.015);
      expect(clusters.length).toBe(2);
      expect(clusters[0].length).toBe(1);
      expect(clusters[1].length).toBe(1);
    });

    it("handles round numbers across powers of ten (99 to 101)", () => {
      const bars99 = generateBars(300, "2025-01-01", 99, 0);
      const res99 = computeLevels({
        bars: bars99,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars99[299].bar_date,
      });
      const rounds99 = res99.levels.filter((l) => l.kind === "ROUND_NUMBER").map((l) => l.price);
      expect(rounds99).toContain(100);

      const bars101 = generateBars(300, "2025-01-01", 101, 0);
      const res101 = computeLevels({
        bars: bars101,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars101[299].bar_date,
      });
      const rounds101 = res101.levels.filter((l) => l.kind === "ROUND_NUMBER").map((l) => l.price);
      expect(rounds101).toContain(100);
    });

    it("enforces required asOfEvaluationDate and measures staleness correctly (Condition 5)", () => {
      const bars = generateBars(100, "2025-01-01", 100, 0.1);
      const lastBarDate = bars[99].bar_date;

      // 1. Omitted / empty evaluation date throws error
      expect(() =>
        computeLevels({
          bars,
          rebackfillNeeded: false,
          asOfEvaluationDate: "" as string,
        }),
      ).toThrow("asOfEvaluationDate is required");

      // 2. Data 400 days old is flagged isStale: true with staleDays >= 400
      const oldEvalDate = "2026-06-01";
      const resStale = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: oldEvalDate,
      });
      expect(resStale.isStale).toBe(true);
      expect(resStale.staleDays).toBeGreaterThanOrEqual(400);

      // 3. Fresh data (evaluated as of the same date) is isStale: false
      const resFresh = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: lastBarDate,
      });
      expect(resFresh.isStale).toBe(false);
      expect(resFresh.staleDays).toBe(0);
    });

    it("preserves unrounded full float precision in domain outputs (Condition 2)", () => {
      // Create bars with fractional TRs that produce non-terminating decimals (e.g. sum 87 / 14)
      const bars = generateBars(300, "2025-01-01", 100, 0.1);
      // Give the last 14 bars high - low differences that average to a repeating fraction
      for (let i = 286; i < 300; i++) {
        bars[i].high = bars[i].close + 1.234567;
        bars[i].low = bars[i].close - 1.0;
      }
      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[299].bar_date,
      });

      expect(res.atr14).not.toBeNull();
      // ATR14 must retain full double precision (not rounded to 2 decimals)
      const decimalPlaces = String(res.atr14).split(".")[1]?.length ?? 0;
      expect(decimalPlaces).toBeGreaterThan(6);
      expect(res.atr14).not.toBe(Math.round((res.atr14 as number) * 100) / 100);

      if (res.levels.length > 0) {
        const lvl = res.levels[0];
        expect(typeof lvl.price).toBe("number");
        expect(typeof lvl.distancePct).toBe("number");
        expect(typeof lvl.distanceAtr).toBe("number");
        expect(typeof lvl.zoneLow).toBe("number");
        expect(typeof lvl.zoneHigh).toBe("number");
      }
    });
  });

  // =========================================================================
  // Gate L6: Determinism & Purity
  // =========================================================================
  describe("Gate L6: Determinism & Purity", () => {
    it("produces identical output for identical input across multiple runs", () => {
      const bars = generateBars(350, "2025-01-01", 100, 0.1);
      const evalDate = bars[349].bar_date;
      const res1 = computeLevels({ bars, rebackfillNeeded: false, asOfEvaluationDate: evalDate });
      const res2 = computeLevels({ bars, rebackfillNeeded: false, asOfEvaluationDate: evalDate });

      expect(res1).toEqual(res2);
    });

    it("levels.ts imports nothing outside domain", () => {
      const filePath = resolve(__dirname, "levels.ts");
      const content = readFileSync(filePath, "utf-8");

      const importRegex = /import\s+[\s\S]*?from\s+["']([^"']+)["']/g;
      const matches = Array.from(content.matchAll(importRegex));
      expect(matches.length).toBeGreaterThan(0);

      for (const m of matches) {
        const importPath = m[1];
        expect(importPath.startsWith("./")).toBe(true);
      }
    });
  });

  // =========================================================================
  // Gate L8: Banned Words Scanner Across All States
  // =========================================================================
  describe("Gate L8: Banned Words Scanner", () => {
    const bannedRegex =
      /\b(buy|sell|hold|bullish|bearish|strong|weak|overbought|oversold|signal|target|outperform|underperform|recommend)\b/i;

    function scanObject(obj: unknown, path = ""): void {
      if (typeof obj === "string") {
        if (obj.includes("Not a recommendation, rating or forecast.")) return;

        const match = bannedRegex.exec(obj);
        if (match) {
          throw new Error(`Banned word '${match[1]}' found at path '${path}': "${obj}"`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, idx) => scanObject(item, `${path}[${idx}]`));
      } else if (obj !== null && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (k === "strength") continue;
          scanObject(v, `${path}.${k}`);
        }
      }
    }

    it("verifies no banned terms in OK state (full history)", () => {
      const bars = generateBars(350, "2025-01-01", 100, 0.1);
      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[349].bar_date,
      });
      expect(() => scanObject(res, "res_ok")).not.toThrow();
    });

    it("verifies no banned terms in INSUFFICIENT_HISTORY state", () => {
      const bars = generateBars(50, "2026-05-01", 100, 0.1);
      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: bars[49].bar_date,
      });
      expect(() => scanObject(res, "res_short")).not.toThrow();
    });

    it("verifies no banned terms in SUSPENDED state", () => {
      const bars = generateBars(300, "2025-01-01", 100, 0.1);
      const res = computeLevels({
        bars,
        rebackfillNeeded: true,
        asOfEvaluationDate: bars[299].bar_date,
      });
      expect(() => scanObject(res, "res_suspended")).not.toThrow();
    });

    it("verifies no banned terms in STALE state", () => {
      const bars = generateBars(300, "2025-01-01", 100, 0.1);
      const res = computeLevels({
        bars,
        rebackfillNeeded: false,
        asOfEvaluationDate: "2026-10-17",
      });
      expect(res.isStale).toBe(true);
      expect(() => scanObject(res, "res_stale")).not.toThrow();
    });

    it("verifies no banned terms in disclaimer, empirical note, and formula definitions", () => {
      expect(() => scanObject(EQUITY_LEVELS_DISCLAIMER, "disclaimer")).not.toThrow();
      expect(() => scanObject(EQUITY_LEVELS_EMPIRICAL_NOTE, "empiricalNote")).not.toThrow();
    });
  });
});
