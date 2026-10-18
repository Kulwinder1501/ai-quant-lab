/**
 * Equity Watch: Levels Engine Domain Logic (Work Package B, Step B1)
 *
 * Strict Architectural Rules (from 2026-10-17-equity-levels-and-r0-plan.md):
 * 1. Pure functions only: no database, no clock, no network calls.
 * 2. Deterministic: same inputs produce identical outputs.
 * 3. Strictly descriptive: "what happened", never "what to do" or "what will happen".
 * 4. Zero predictive indicators or sentiment: no directional advice or ratings.
 * 5. Parameters imported from equity-rules-v1.json (or passed in).
 */

import rulesData from "./equity-rules-v1.json" with { type: "json" };
import {
  calendarDaysDifference,
  calendarDaysPrior,
  formatDateParts,
  parseDateParts,
  subtractCalendarDays,
  subtractCalendarMonths,
} from "./trend-metrics.js";

export const EQUITY_LEVELS_DISCLAIMER =
  "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.";

export const EQUITY_LEVELS_EMPIRICAL_NOTE =
  "Levels come from past prices and show where the market reacted before. In our test on 49 large Indian stocks, touches of such levels did not reliably predict the next 20 days, and breaks of resistance were followed by lower, not higher, returns.";

export type LevelState = "INTACT" | "BROKEN" | "FLIPPED";
export type LevelSide = "SUPPORT" | "RESISTANCE";
export type LevelKind =
  | "SWING"
  | "52W_HIGH"
  | "52W_LOW"
  | "SMA_50"
  | "SMA_200"
  | "ROUND_NUMBER"
  | "GAP"
  | "VOLUME_PROFILE_POC"
  | "VOLUME_PROFILE_VAH"
  | "VOLUME_PROFILE_VAL";

export interface LevelItem {
  id: string;
  price: number;
  kind: LevelKind;
  source: string;
  side: LevelSide;
  touches: number;
  strength: number;
  firstDate: string;
  lastDate: string;
  distancePct: number;
  distanceAtr: number;
  zoneLow: number;
  zoneHigh: number;
  state: LevelState;
  brokenOn: string | null;
  volume?: number;
}

export interface SwingPivot {
  price: number;
  barDate: string;
  barIndex: number;
  volume: number;
  kind: "SWING_LOW" | "SWING_HIGH";
}

export interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  binWidth: number;
  totalVolume: number;
}

export interface LevelsInput {
  bars: Array<{
    bar_date: string; // YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  rebackfillNeeded: boolean;
  asOfEvaluationDate: string; // REQUIRED: Reference date (YYYY-MM-DD, e.g. today in IST) for staleness
  seriesVersion?: number;
  rulesConfig?: typeof rulesData;
}

export interface LevelsResult {
  asOfDate: string | null;
  isStale: boolean;
  staleDays: number;
  rebackfillNeeded: boolean;
  seriesVersion: number;
  state: "OK" | "INSUFFICIENT_HISTORY" | "SUSPENDED" | "NOT_MEANINGFUL";
  atr14: number | null;
  atrPercent: number | null;
  levels: LevelItem[];
  nearestSupport: LevelItem | null;
  nearestResistance: LevelItem | null;
  riskDistanceAtr: number | null;
  warnings: string[];
  disclaimer: string;
  empiricalNote: string;
  formulas: Record<string, string>;
}

/**
 * Calculates True Range for each bar:
 * TR_t = max(high_t - low_t, abs(high_t - close_{t-1}), abs(low_t - close_{t-1}))
 * TR_0 = high_0 - low_0
 */
export function computeTrueRanges(
  bars: Array<{ high: number; low: number; close: number }>,
): number[] {
  if (bars.length === 0) return [];
  const trs: number[] = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  return trs;
}

/**
 * Plain mean of the last 14 True Ranges (not Wilder smoothed).
 */
export function computeAtr14(
  bars: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number | null {
  if (bars.length < period) return null;
  const trs = computeTrueRanges(bars);
  const lastN = trs.slice(trs.length - period);
  const sum = lastN.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Identifies swing pivots with half-window k (k bars before, k bars after).
 * Pivot at i is usable only from bar i + k.
 */
export function findSwingPivots(
  bars: Array<{ bar_date: string; low: number; high: number; volume: number }>,
  k = 5,
  lookbackBars = 252,
): SwingPivot[] {
  const totalBars = bars.length;
  if (totalBars < 2 * k + 1) return [];

  const pivots: SwingPivot[] = [];
  const T = totalBars - 1;
  const minIndex = Math.max(k, T - lookbackBars);
  const maxIndex = T - k;

  for (let i = minIndex; i <= maxIndex; i++) {
    const currLow = bars[i].low;
    const currHigh = bars[i].high;

    // Swing Low check
    let isSwingLow = true;
    for (let j = i - k; j <= i - 1; j++) {
      if (currLow >= bars[j].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      for (let j = i + 1; j <= i + k; j++) {
        if (currLow > bars[j].low) {
          isSwingLow = false;
          break;
        }
      }
    }
    if (isSwingLow) {
      pivots.push({
        price: currLow,
        barDate: bars[i].bar_date,
        barIndex: i,
        volume: bars[i].volume,
        kind: "SWING_LOW",
      });
    }

    // Swing High check
    let isSwingHigh = true;
    for (let j = i - k; j <= i - 1; j++) {
      if (currHigh <= bars[j].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      for (let j = i + 1; j <= i + k; j++) {
        if (currHigh < bars[j].high) {
          isSwingHigh = false;
          break;
        }
      }
    }
    if (isSwingHigh) {
      pivots.push({
        price: currHigh,
        barDate: bars[i].bar_date,
        barIndex: i,
        volume: bars[i].volume,
        kind: "SWING_HIGH",
      });
    }
  }

  return pivots;
}

/**
 * Single-linkage clustering of pivot prices.
 * Groups prices sorted ascending whenever the gap between adjacent prices <= clusterGapPct * lowerPrice.
 */
export function clusterPivots(
  pivots: SwingPivot[],
  clusterGapPct = 0.015,
): SwingPivot[][] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);

  const clusters: SwingPivot[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = (curr.price - prev.price) / prev.price;
    if (gap <= clusterGapPct) {
      clusters[clusters.length - 1].push(curr);
    } else {
      clusters.push([curr]);
    }
  }

  return clusters;
}

/**
 * Computes 60-bin volume profile over the lookback window.
 */
export function computeVolumeProfile(
  bars: Array<{ low: number; high: number; volume: number }>,
  binsCount = 60,
  valueAreaPct = 0.70,
): VolumeProfileResult | null {
  if (bars.length === 0) return null;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  let totalVolume = 0;

  for (const b of bars) {
    if (b.low < minLow) minLow = b.low;
    if (b.high > maxHigh) maxHigh = b.high;
    totalVolume += b.volume;
  }

  if (minLow >= maxHigh || totalVolume === 0) return null;

  const binWidth = (maxHigh - minLow) / binsCount;
  const binVolumes = new Float64Array(binsCount);

  for (const b of bars) {
    if (b.volume <= 0) continue;
    // Find touched bins
    const startBin = Math.max(0, Math.min(binsCount - 1, Math.floor((b.low - minLow) / binWidth)));
    const endBin = Math.max(0, Math.min(binsCount - 1, Math.floor((b.high - minLow) / binWidth)));
    const touchedCount = endBin - startBin + 1;
    const volPerBin = b.volume / touchedCount;
    for (let bi = startBin; bi <= endBin; bi++) {
      binVolumes[bi] += volPerBin;
    }
  }

  // Find POC (highest volume bin midpoint)
  let pocIndex = 0;
  let maxBinVol = -1;
  for (let i = 0; i < binsCount; i++) {
    if (binVolumes[i] > maxBinVol) {
      maxBinVol = binVolumes[i];
      pocIndex = i;
    }
  }
  const poc = minLow + (pocIndex + 0.5) * binWidth;

  // Value Area: contiguous expansion around POC until volume reaches valueAreaPct * totalVolume
  const desiredVaVolume = totalVolume * valueAreaPct;
  let vaVolume = binVolumes[pocIndex];
  let vaLowIndex = pocIndex;
  let vaHighIndex = pocIndex;

  while (vaVolume < desiredVaVolume && (vaLowIndex > 0 || vaHighIndex < binsCount - 1)) {
    const nextLowerVol = vaLowIndex > 0 ? binVolumes[vaLowIndex - 1] : -1;
    const nextHigherVol = vaHighIndex < binsCount - 1 ? binVolumes[vaHighIndex + 1] : -1;

    if (nextLowerVol >= nextHigherVol && nextLowerVol >= 0) {
      vaLowIndex--;
      vaVolume += nextLowerVol;
    } else if (nextHigherVol >= 0) {
      vaHighIndex++;
      vaVolume += nextHigherVol;
    } else if (nextLowerVol >= 0) {
      vaLowIndex--;
      vaVolume += nextLowerVol;
    } else {
      break;
    }
  }

  const val = minLow + vaLowIndex * binWidth;
  const vah = minLow + (vaHighIndex + 1) * binWidth;

  return {
    poc,
    vah,
    val,
    binWidth,
    totalVolume,
  };
}

/**
 * Main Levels Engine pure calculation function.
 */
export function computeLevels(input: LevelsInput): LevelsResult {
  const rules = input.rulesConfig ?? rulesData;
  const { levels: levelsRules } = rules;
  const {
    pivotHalfWindow,
    lookbackBars,
    clusterGapPct,
    minPivots,
    zoneMinPct,
    zoneAtrMultiple,
    atrPeriod,
    recencyHalfLifeBars,
    roundNumberRangePct,
    gapMinAtr,
    volumeProfileBins,
    valueAreaPct,
    brokenLookbackBars,
    largeMovePct,
    artifactMovePct = 0.40,
  } = levelsRules;

  const formulas: Record<string, string> = {
    swing: `Single-linkage price cluster (gap <= ${clusterGapPct * 100}%) of swing pivots (half-window ${pivotHalfWindow}), touches >= ${minPivots}`,
    zone: `half-width w = max(${zoneMinPct * 100}% of level, ${zoneAtrMultiple} * ATR14)`,
    atr: `Plain mean of last ${atrPeriod} True Ranges: TR = max(H-L, |H-C_prev|, |L-C_prev|)`,
    broken: `Close beyond level +/- w within last ${brokenLookbackBars} bars after pivot was known`,
    high52w: "Highest high in last 365 calendar days",
    low52w: "Lowest low in last 365 calendar days",
    sma50: "Simple moving average of last 50 trading day closes",
    sma200: "Simple moving average of last 200 trading day closes",
    roundNumber: "Multiples of (10^floor(log10(P)) / 2) within 15% of close",
    unfilledGap: `Unfilled price gap >= ${gapMinAtr} * ATR14 within last ${lookbackBars} bars`,
    volumeProfile: `${volumeProfileBins} equal bins over last ${lookbackBars} bars. POC = modal bin midpoint; Value Area = ${valueAreaPct * 100}% volume range`,
  };

  const globalWarnings: string[] = [];

  // Filter and sort bars ascending by date
  const rawBars = input.bars ?? [];
  const validBars: typeof input.bars = [];
  for (const b of rawBars) {
    if (
      Number.isFinite(b.close) &&
      b.close > 0 &&
      Number.isFinite(b.high) &&
      b.high > 0 &&
      Number.isFinite(b.low) &&
      b.low > 0
    ) {
      validBars.push(b);
    } else {
      globalWarnings.push(`Excluded invalid bar with non-positive values on ${b.bar_date}.`);
    }
  }
  validBars.sort((a, b) => a.bar_date.localeCompare(b.bar_date));

  const totalBars = validBars.length;
  const lastBar = totalBars > 0 ? validBars[totalBars - 1] : null;
  const asOfDate = lastBar?.bar_date ?? null;

  // Condition 5: Evaluation date is required to evaluate data freshness
  const evalDate = input.asOfEvaluationDate;
  if (!evalDate) {
    throw new Error("asOfEvaluationDate is required to evaluate data freshness.");
  }

  let isStale = false;
  let staleDays = 0;
  if (asOfDate) {
    staleDays = calendarDaysDifference(evalDate, asOfDate);
    if (staleDays > 4) {
      isStale = true;
      globalWarnings.push(`Price data is as of ${asOfDate} (${staleDays} calendar days ago).`);
    }
  }

  // Suspended state check
  if (input.rebackfillNeeded) {
    return {
      asOfDate,
      isStale,
      staleDays,
      rebackfillNeeded: true,
      seriesVersion: input.seriesVersion ?? 1,
      state: "SUSPENDED",
      atr14: null,
      atrPercent: null,
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      riskDistanceAtr: null,
      warnings: ["Calculations suspended: full price series re-backfill pending."],
      disclaimer: EQUITY_LEVELS_DISCLAIMER,
      empiricalNote: EQUITY_LEVELS_EMPIRICAL_NOTE,
      formulas,
    };
  }

  // Condition 1: Check for large moves (> 20%) and suspected corporate-action artifacts (> 40%)
  let latestArtifactIndex = -1;
  let latestArtifactDate: string | null = null;
  let latestArtifactMove = 0;

  for (let i = 1; i < totalBars; i++) {
    const prevC = validBars[i - 1].close;
    const currC = validBars[i].close;
    const change = currC / prevC - 1;
    const absChange = Math.abs(change);

    if (absChange > artifactMovePct) {
      latestArtifactIndex = i;
      latestArtifactDate = validBars[i].bar_date;
      latestArtifactMove = change;
    }

    if (absChange > largeMovePct) {
      const pctStr = `${change > 0 ? "+" : ""}${(change * 100).toFixed(2)}%`;
      globalWarnings.push(
        `Contains a one-day move of ${pctStr} on ${validBars[i].bar_date}, which may be an unadjusted corporate action.`,
      );
    }
  }

  // Slicing series strictly after the latest corporate-action artifact
  let usableBars = validBars;
  if (latestArtifactIndex >= 0) {
    const pctStr = `${latestArtifactMove > 0 ? "+" : ""}${(latestArtifactMove * 100).toFixed(2)}%`;
    globalWarnings.push(
      `Suspected corporate-action artifact of ${pctStr} on ${latestArtifactDate}: calculations use only subsequent data.`,
    );
    usableBars = validBars.slice(latestArtifactIndex + 1);
  }

  const usableCount = usableBars.length;
  const currentClose = usableCount > 0 ? usableBars[usableCount - 1].close : (lastBar?.close ?? 0);

  // Condition 4: Requires at least atrPeriod (14) bars. No invented 2% fallback.
  if (usableCount < atrPeriod || !lastBar) {
    const reasonWarning =
      latestArtifactIndex >= 0
        ? `Requires at least ${atrPeriod} trading bars after artifact on ${latestArtifactDate} to compute price levels; ${usableCount} available.`
        : `Requires at least ${atrPeriod} trading bars to compute price levels; ${usableCount} available.`;
    return {
      asOfDate,
      isStale,
      staleDays,
      rebackfillNeeded: false,
      seriesVersion: input.seriesVersion ?? 1,
      state: "INSUFFICIENT_HISTORY",
      atr14: null,
      atrPercent: null,
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      riskDistanceAtr: null,
      warnings: Array.from(new Set([...globalWarnings, reasonWarning])),
      disclaimer: EQUITY_LEVELS_DISCLAIMER,
      empiricalNote: EQUITY_LEVELS_EMPIRICAL_NOTE,
      formulas,
    };
  }

  // Preliminary volume notice
  globalWarnings.push("Latest day volume is preliminary.");

  // Calculate ATR14 and ATR%
  const atr14 = computeAtr14(usableBars, atrPeriod);
  if (atr14 === null) {
    return {
      asOfDate,
      isStale,
      staleDays,
      rebackfillNeeded: false,
      seriesVersion: input.seriesVersion ?? 1,
      state: "INSUFFICIENT_HISTORY",
      atr14: null,
      atrPercent: null,
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      riskDistanceAtr: null,
      warnings: Array.from(new Set([...globalWarnings, `Requires at least ${atrPeriod} trading bars to compute ATR.`])),
      disclaimer: EQUITY_LEVELS_DISCLAIMER,
      empiricalNote: EQUITY_LEVELS_EMPIRICAL_NOTE,
      formulas,
    };
  }

  const atrPercent = atr14 / currentClose;
  const levels: LevelItem[] = [];
  const T = usableCount - 1;

  // Condition 2: Helper to build a level item (Full precision, no rounding inside domain)
  const buildLevelItem = (params: {
    id: string;
    price: number;
    kind: LevelKind;
    source: string;
    touches: number;
    strength: number;
    firstDate: string;
    lastDate: string;
    state?: LevelState;
    brokenOn?: string | null;
    volume?: number;
  }): LevelItem => {
    const price = params.price;
    const side: LevelSide = price < currentClose ? "SUPPORT" : "RESISTANCE";
    const w = Math.max(zoneMinPct * price, zoneAtrMultiple * atr14);
    const distPct = (currentClose - price) / price;
    const distAtr = (currentClose - price) / atr14;

    return {
      id: params.id,
      price,
      kind: params.kind,
      source: params.source,
      side,
      touches: params.touches,
      strength: params.strength,
      firstDate: params.firstDate,
      lastDate: params.lastDate,
      distancePct: distPct,
      distanceAtr: distAtr,
      zoneLow: price - w,
      zoneHigh: price + w,
      state: params.state ?? "INTACT",
      brokenOn: params.brokenOn ?? null,
      volume: params.volume,
    };
  };

  // Condition 3: Swing Clusters requires at least lookbackBars + pivotHalfWindow + 1 (258 bars)
  const requiredBarsForSwing = lookbackBars + pivotHalfWindow + 1;
  if (usableCount >= requiredBarsForSwing) {
    const pivots = findSwingPivots(usableBars, pivotHalfWindow, lookbackBars);
    const clusters = clusterPivots(pivots, clusterGapPct);

    clusters.forEach((cluster, idx) => {
      if (cluster.length < minPivots) return; // Must have touches >= minPivots

      const clusterPriceSum = cluster.reduce((sum, p) => sum + p.price, 0);
      const levelPrice = clusterPriceSum / cluster.length;

      // Recency-weighted strength: sum(0.5 ^ (age_in_bars / recencyHalfLifeBars))
      let strength = 0;
      let clusterVol = 0;
      let earliestDate = cluster[0].barDate;
      let latestDate = cluster[0].barDate;
      let latestPivotIndex = cluster[0].barIndex;

      for (const p of cluster) {
        const age = T - p.barIndex;
        strength += Math.pow(0.5, age / recencyHalfLifeBars);
        clusterVol += p.volume;
        if (p.barDate < earliestDate) earliestDate = p.barDate;
        if (p.barDate > latestDate) latestDate = p.barDate;
        if (p.barIndex > latestPivotIndex) latestPivotIndex = p.barIndex;
      }

      // Break / Flip analysis:
      // A pivot is known only from bar p.barIndex + pivotHalfWindow.
      // Check bars in last brokenLookbackBars after the latest pivot was known.
      const knownFromBar = latestPivotIndex + pivotHalfWindow;
      const checkStart = Math.max(T - brokenLookbackBars + 1, knownFromBar);
      const w = Math.max(zoneMinPct * levelPrice, zoneAtrMultiple * atr14);

      // Determine the side of the level prior to the observation window
      const priorBarIndex = Math.max(0, checkStart - 1);
      const priorClose = usableBars[priorBarIndex].close;
      let priorSide: LevelSide;
      if (priorClose > levelPrice) {
        priorSide = "SUPPORT";
      } else if (priorClose < levelPrice) {
        priorSide = "RESISTANCE";
      } else {
        const latestPivot = cluster.reduce(
          (latest, p) => (p.barIndex > latest.barIndex ? p : latest),
          cluster[0],
        );
        priorSide = latestPivot.kind === "SWING_LOW" ? "SUPPORT" : "RESISTANCE";
      }

      let isBroken = false;
      let brokenOn: string | null = null;

      for (let bi = checkStart; bi <= T; bi++) {
        const barClose = usableBars[bi].close;
        if (priorSide === "SUPPORT" && barClose < levelPrice - w) {
          isBroken = true;
          brokenOn = usableBars[bi].bar_date;
          break;
        } else if (priorSide === "RESISTANCE" && barClose > levelPrice + w) {
          isBroken = true;
          brokenOn = usableBars[bi].bar_date;
          break;
        }
      }

      let state: LevelState = "INTACT";
      if (isBroken) {
        const currentSide: LevelSide = levelPrice < currentClose ? "SUPPORT" : "RESISTANCE";
        state = currentSide !== priorSide ? "FLIPPED" : "BROKEN";
      }

      levels.push(
        buildLevelItem({
          id: `swing-${idx}-${levelPrice.toFixed(2)}`,
          price: levelPrice,
          kind: "SWING",
          source: "Swing Clusters",
          touches: cluster.length,
          strength,
          firstDate: earliestDate,
          lastDate: latestDate,
          state,
          brokenOn,
          volume: clusterVol,
        }),
      );
    });
  } else {
    globalWarnings.push(
      `Requires at least ${requiredBarsForSwing} trading bars to compute swing levels; ${usableCount} available.`,
    );
  }

  // 3. Reference Level: 52-Week High & Low (bars strictly within last 365 days)
  const cutoffDate = subtractCalendarDays(lastBar.bar_date, 365);
  let high52W = -Infinity;
  let high52WDate = lastBar.bar_date;
  let low52W = Infinity;
  let low52WDate = lastBar.bar_date;

  for (let i = usableCount - 1; i >= 0; i--) {
    if (usableBars[i].bar_date <= cutoffDate) break;
    if (usableBars[i].high > high52W) {
      high52W = usableBars[i].high;
      high52WDate = usableBars[i].bar_date;
    }
    if (usableBars[i].low < low52W) {
      low52W = usableBars[i].low;
      low52WDate = usableBars[i].bar_date;
    }
  }

  if (Number.isFinite(high52W) && high52W > 0) {
    levels.push(
      buildLevelItem({
        id: `ref-52w-high-${high52W.toFixed(2)}`,
        price: high52W,
        kind: "52W_HIGH",
        source: "52-Week High",
        touches: 1,
        strength: 1.0,
        firstDate: high52WDate,
        lastDate: high52WDate,
      }),
    );
  }

  if (Number.isFinite(low52W) && low52W > 0) {
    levels.push(
      buildLevelItem({
        id: `ref-52w-low-${low52W.toFixed(2)}`,
        price: low52W,
        kind: "52W_LOW",
        source: "52-Week Low",
        touches: 1,
        strength: 1.0,
        firstDate: low52WDate,
        lastDate: low52WDate,
      }),
    );
  }

  // 4. Reference Level: 50-Day SMA
  if (usableCount >= 50) {
    const sum50 = usableBars.slice(usableCount - 50).reduce((a, b) => a + b.close, 0);
    const sma50 = sum50 / 50;
    levels.push(
      buildLevelItem({
        id: `ref-sma50-${sma50.toFixed(2)}`,
        price: sma50,
        kind: "SMA_50",
        source: "50-Day SMA",
        touches: 1,
        strength: 1.0,
        firstDate: usableBars[usableCount - 50].bar_date,
        lastDate: lastBar.bar_date,
      }),
    );
  }

  // 5. Reference Level: 200-Day SMA
  if (usableCount >= 200) {
    const sum200 = usableBars.slice(usableCount - 200).reduce((a, b) => a + b.close, 0);
    const sma200 = sum200 / 200;
    levels.push(
      buildLevelItem({
        id: `ref-sma200-${sma200.toFixed(2)}`,
        price: sma200,
        kind: "SMA_200",
        source: "200-Day SMA",
        touches: 1,
        strength: 1.0,
        firstDate: usableBars[usableCount - 200].bar_date,
        lastDate: lastBar.bar_date,
      }),
    );
  }

  // 6. Reference Level: Round Numbers
  if (currentClose > 0) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(currentClose)));
    const step = magnitude / 2;
    const minRange = currentClose * (1 - roundNumberRangePct);
    const maxRange = currentClose * (1 + roundNumberRangePct);

    const firstStep = Math.ceil(minRange / step);
    const lastStep = Math.floor(maxRange / step);

    for (let s = firstStep; s <= lastStep; s++) {
      const rnPrice = s * step;
      levels.push(
        buildLevelItem({
          id: `ref-round-${rnPrice.toFixed(2)}`,
          price: rnPrice,
          kind: "ROUND_NUMBER",
          source: "Round Number",
          touches: 1,
          strength: 1.0,
          firstDate: lastBar.bar_date,
          lastDate: lastBar.bar_date,
        }),
      );
    }
  }

  // 7. Reference Level: Unfilled Gaps (>= 1.0 * ATR14 within lookback)
  if (atr14 > 0) {
    const minGapSize = gapMinAtr * atr14;
    const usableLookbackStart = Math.max(0, usableCount - lookbackBars);
    for (let i = Math.max(1, usableLookbackStart); i <= T; i++) {
      const prevBar = usableBars[i - 1];
      const currBar = usableBars[i];

      // Gap Up: low_i > high_{i-1}
      if (currBar.low - prevBar.high >= minGapSize) {
        const gapEdge = prevBar.high;
        let isFilled = false;
        for (let j = i + 1; j <= T; j++) {
          if (usableBars[j].low <= gapEdge) {
            isFilled = true;
            break;
          }
        }
        if (!isFilled) {
          levels.push(
            buildLevelItem({
              id: `ref-gap-up-${prevBar.bar_date}-${gapEdge.toFixed(2)}`,
              price: gapEdge,
              kind: "GAP",
              source: "Unfilled Gap Up Edge",
              touches: 1,
              strength: 1.0,
              firstDate: prevBar.bar_date,
              lastDate: currBar.bar_date,
            }),
          );
        }
      }

      // Gap Down: high_i < low_{i-1}
      if (prevBar.low - currBar.high >= minGapSize) {
        const gapEdge = prevBar.low;
        let isFilled = false;
        for (let j = i + 1; j <= T; j++) {
          if (usableBars[j].high >= gapEdge) {
            isFilled = true;
            break;
          }
        }
        if (!isFilled) {
          levels.push(
            buildLevelItem({
              id: `ref-gap-down-${prevBar.bar_date}-${gapEdge.toFixed(2)}`,
              price: gapEdge,
              kind: "GAP",
              source: "Unfilled Gap Down Edge",
              touches: 1,
              strength: 1.0,
              firstDate: prevBar.bar_date,
              lastDate: currBar.bar_date,
            }),
          );
        }
      }
    }
  }

  // 8. Reference Level: Volume Profile (POC, VAH, VAL over lookback)
  const windowBarsForVp = usableBars.slice(Math.max(0, usableCount - lookbackBars));
  const vp = computeVolumeProfile(windowBarsForVp, volumeProfileBins, valueAreaPct);
  if (vp) {
    levels.push(
      buildLevelItem({
        id: `ref-vp-poc-${vp.poc.toFixed(2)}`,
        price: vp.poc,
        kind: "VOLUME_PROFILE_POC",
        source: "Volume Profile POC",
        touches: 1,
        strength: 1.0,
        firstDate: windowBarsForVp[0].bar_date,
        lastDate: lastBar.bar_date,
        volume: vp.totalVolume,
      }),
    );
    levels.push(
      buildLevelItem({
        id: `ref-vp-vah-${vp.vah.toFixed(2)}`,
        price: vp.vah,
        kind: "VOLUME_PROFILE_VAH",
        source: "Volume Profile VAH",
        touches: 1,
        strength: 1.0,
        firstDate: windowBarsForVp[0].bar_date,
        lastDate: lastBar.bar_date,
      }),
    );
    levels.push(
      buildLevelItem({
        id: `ref-vp-val-${vp.val.toFixed(2)}`,
        price: vp.val,
        kind: "VOLUME_PROFILE_VAL",
        source: "Volume Profile VAL",
        touches: 1,
        strength: 1.0,
        firstDate: windowBarsForVp[0].bar_date,
        lastDate: lastBar.bar_date,
      }),
    );
  }

  // Sort levels by distance from current price ascending
  levels.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));

  // Determine nearest swing support and resistance (SWING levels only)
  let nearestSupport: LevelItem | null = null;
  let nearestResistance: LevelItem | null = null;
  let minSupportDist = Infinity;
  let minResistanceDist = Infinity;

  for (const lvl of levels) {
    if (lvl.kind === "SWING") {
      if (lvl.side === "SUPPORT") {
        const dist = currentClose - lvl.price;
        if (dist >= 0 && dist < minSupportDist) {
          minSupportDist = dist;
          nearestSupport = lvl;
        }
      } else if (lvl.side === "RESISTANCE") {
        const dist = lvl.price - currentClose;
        if (dist >= 0 && dist < minResistanceDist) {
          minResistanceDist = dist;
          nearestResistance = lvl;
        }
      }
    }
  }

  // Risk distance in ATR: distance to nearest support (Full precision, no rounding)
  const riskDistanceAtr =
    nearestSupport && atr14 > 0
      ? (currentClose - nearestSupport.price) / atr14
      : null;

  // Condition 3: Determine overall state (OK only if swing levels could be produced with >= 258 bars)
  const state =
    usableCount < requiredBarsForSwing
      ? "INSUFFICIENT_HISTORY"
      : "OK";

  return {
    asOfDate,
    isStale,
    staleDays,
    rebackfillNeeded: false,
    seriesVersion: input.seriesVersion ?? 1,
    state,
    atr14,
    atrPercent,
    levels,
    nearestSupport,
    nearestResistance,
    riskDistanceAtr,
    warnings: Array.from(new Set(globalWarnings)),
    disclaimer: EQUITY_LEVELS_DISCLAIMER,
    empiricalNote: EQUITY_LEVELS_EMPIRICAL_NOTE,
    formulas,
  };
}
