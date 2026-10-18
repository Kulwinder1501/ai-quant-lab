"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  HelpCircle,
  Info,
  Layers,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type {
  LevelsPanelResponse,
  WatchlistStockItem,
} from "../types";

export const EQUITY_LEVELS_DISCLAIMER =
  "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.";

export const EQUITY_LEVELS_EMPIRICAL_NOTE =
  "Levels come from past prices and show where the market reacted before. In our test on 49 large Indian stocks, touches of such levels did not reliably predict the next 20 days, and breaks of resistance were followed by lower, not higher, returns.";

interface EquityLevelsPanelProps {
  levelsData: LevelsPanelResponse | null;
  isLoading: boolean;
  error: string | null;
  stock: WatchlistStockItem;
}

type SourceFilter = "ALL" | "SWING" | "52W" | "AVERAGE" | "ROUND" | "GAP" | "VOLUME_PROFILE";

export function EquityLevelsPanel({
  levelsData,
  isLoading,
  error,
  stock,
}: EquityLevelsPanelProps) {
  const [showFormulas, setShowFormulas] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("ALL");

  const formatCurrency = (val: number | null | undefined) => {
    if (val === null || val === undefined || isNaN(val)) return "—";
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatPercent = (val: number | null | undefined) => {
    if (val === null || val === undefined || isNaN(val)) return "—";
    const sign = val > 0 ? "+" : "";
    return `${sign}${(val * 100).toFixed(2)}%`;
  };

  const formatDistanceAtr = (val: number | null | undefined) => {
    if (val === null || val === undefined || isNaN(val)) return "—";
    const sign = val > 0 ? "+" : "";
    return `${sign}${val.toFixed(2)} ATR`;
  };

  const filteredLevels = useMemo(() => {
    if (!levelsData || !levelsData.levels) return [];
    let list = [...levelsData.levels];

    if (sourceFilter === "SWING") {
      list = list.filter((l) => l.kind === "SWING");
    } else if (sourceFilter === "52W") {
      list = list.filter((l) => l.kind === "52W_HIGH" || l.kind === "52W_LOW");
    } else if (sourceFilter === "AVERAGE") {
      list = list.filter((l) => l.kind === "SMA_50" || l.kind === "SMA_200");
    } else if (sourceFilter === "ROUND") {
      list = list.filter((l) => l.kind === "ROUND_NUMBER");
    } else if (sourceFilter === "GAP") {
      list = list.filter((l) => l.kind === "GAP");
    } else if (sourceFilter === "VOLUME_PROFILE") {
      list = list.filter(
        (l) =>
          l.kind === "VOLUME_PROFILE_POC" ||
          l.kind === "VOLUME_PROFILE_VAH" ||
          l.kind === "VOLUME_PROFILE_VAL",
      );
    }

    return list.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
  }, [levelsData, sourceFilter]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <Loader2 className="size-8 animate-spin text-cyan-400" />
        <p className="mt-3 text-sm font-medium">Computing descriptive levels and reference points…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-6 text-rose-300">
        <div className="flex items-center gap-2 font-semibold">
          <AlertCircle className="size-5 text-rose-400" />
          <span>Unable to load price levels</span>
        </div>
        <p className="mt-2 text-sm text-rose-300/80">{error}</p>
      </div>
    );
  }

  if (!levelsData) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-400">
        <Info className="mx-auto size-8 text-slate-500" />
        <p className="mt-2 text-sm font-medium">No price bar data available for {stock.symbol}.</p>
        <p className="text-xs text-slate-500 mt-1">
          Historical bars are needed to calculate descriptive levels and reference points.
        </p>
      </div>
    );
  }

  const {
    asOfDate,
    isStale,
    staleDays,
    rebackfillNeeded,
    state,
    atr14,
    atrPercent,
    nearestSupport,
    nearestResistance,
    riskDistanceAtr,
    warnings,
    formulas,
  } = levelsData;

  const isSuspended = rebackfillNeeded || state === "SUSPENDED";
  const isShortHistory = state === "INSUFFICIENT_HISTORY";

  return (
    <div className="space-y-6">
      {/* 1. As-of line & State Banners */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-1.5 font-mono">
            <Clock className="size-3.5 text-cyan-400" />
            <span>
              {asOfDate ? (
                <>
                  Based on daily bars up to <span className="font-bold text-white">{asOfDate}</span>
                </>
              ) : (
                <span className="text-slate-400">No daily bars stored yet</span>
              )}
            </span>
          </div>
          {atr14 !== null && (
            <div className="font-mono text-xs text-slate-400">
              ATR(14): <span className="font-semibold text-slate-200">{formatCurrency(atr14)}</span>
              {atrPercent !== null && (
                <span className="text-slate-400 ml-1">({(atrPercent * 100).toFixed(2)}%)</span>
              )}
            </div>
          )}
        </div>

        {/* Suspended Banner */}
        {isSuspended && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <RefreshCw className="size-4 shrink-0 mt-0.5 text-amber-400 animate-spin" />
            <div>
              <span className="font-bold block">Calculations Suspended: Re-backfill Needed</span>
              <span>
                Historical restatement or split detected in price series. Descriptive calculations will resume after full series re-backfill.
              </span>
            </div>
          </div>
        )}

        {/* Stale Banner */}
        {isStale && !isSuspended && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <AlertTriangle className="size-4 shrink-0 mt-0.5 text-amber-400" />
            <div>
              <span className="font-bold block">Price Data Stale</span>
              <span>
                Price data is as of {asOfDate} ({staleDays} calendar days ago). Calculations reflect the latest stored daily bars.
              </span>
            </div>
          </div>
        )}

        {/* Insufficient History Banner */}
        {isShortHistory && !isSuspended && (
          <div className="flex items-start gap-2.5 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-200">
            <Info className="size-4 shrink-0 mt-0.5 text-sky-400" />
            <div>
              <span className="font-bold block">Reference Levels Only: History Under 258 Bars</span>
              <span>
                Swing pivot clusters require 258 continuous daily bars. Swing levels are omitted, but standard reference levels (52-week extremes, moving averages, round numbers, volume profile) are shown below.
              </span>
            </div>
          </div>
        )}

        {/* General / Artifact Warnings */}
        {!isSuspended && warnings && warnings.length > 0 && (
          <div className="space-y-1.5">
            {Array.from(new Set(warnings)).map((w, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300"
              >
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-400" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Nearest Support & Resistance Overview Cards */}
      {!isSuspended && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Nearest Support Card */}
          <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-2">
              <span className="uppercase font-semibold tracking-wider text-slate-300">Nearest Support</span>
              {nearestSupport && (
                <span className="rounded px-1.5 py-0.5 text-[10px] bg-slate-800 text-slate-300 border border-white/10 font-mono">
                  {nearestSupport.state}
                </span>
              )}
            </div>
            {nearestSupport ? (
              <div>
                <div className="text-xl font-bold font-mono text-white">
                  {formatCurrency(nearestSupport.price)}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs font-mono text-slate-300">
                  <span>{formatPercent(nearestSupport.distancePct)}</span>
                  <span className="text-slate-500">·</span>
                  <span>{formatDistanceAtr(nearestSupport.distanceAtr)}</span>
                </div>
                <div className="mt-2.5 pt-2.5 border-t border-white/5 text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between">
                    <span>Touches (Weighted)</span>
                    <span className="font-mono text-slate-200">
                      {nearestSupport.touches} ({nearestSupport.strength.toFixed(2)})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Zone</span>
                    <span className="font-mono text-slate-200">
                      [{formatCurrency(nearestSupport.zoneLow)} – {formatCurrency(nearestSupport.zoneHigh)}]
                    </span>
                  </div>
                  <div className="flex justify-between truncate">
                    <span>Source</span>
                    <span className="font-mono text-slate-300 truncate max-w-[140px] text-right">
                      {nearestSupport.source}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-4 text-xs text-slate-500 font-mono italic">
                {isShortHistory ? "Needs 258 bars for swing support" : "None within lookback window"}
              </div>
            )}
          </div>

          {/* Nearest Resistance Card */}
          <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-2">
              <span className="uppercase font-semibold tracking-wider text-slate-300">Nearest Resistance</span>
              {nearestResistance && (
                <span className="rounded px-1.5 py-0.5 text-[10px] bg-slate-800 text-slate-300 border border-white/10 font-mono">
                  {nearestResistance.state}
                </span>
              )}
            </div>
            {nearestResistance ? (
              <div>
                <div className="text-xl font-bold font-mono text-white">
                  {formatCurrency(nearestResistance.price)}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs font-mono text-slate-300">
                  <span>{formatPercent(nearestResistance.distancePct)}</span>
                  <span className="text-slate-500">·</span>
                  <span>{formatDistanceAtr(nearestResistance.distanceAtr)}</span>
                </div>
                <div className="mt-2.5 pt-2.5 border-t border-white/5 text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between">
                    <span>Touches (Weighted)</span>
                    <span className="font-mono text-slate-200">
                      {nearestResistance.touches} ({nearestResistance.strength.toFixed(2)})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Zone</span>
                    <span className="font-mono text-slate-200">
                      [{formatCurrency(nearestResistance.zoneLow)} – {formatCurrency(nearestResistance.zoneHigh)}]
                    </span>
                  </div>
                  <div className="flex justify-between truncate">
                    <span>Source</span>
                    <span className="font-mono text-slate-300 truncate max-w-[140px] text-right">
                      {nearestResistance.source}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-4 text-xs text-slate-500 font-mono italic">
                {isShortHistory ? "Needs 258 bars for swing resistance" : "None within lookback window"}
              </div>
            )}
          </div>

          {/* Distance to Nearest Support (Risk Distance) */}
          <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-2">
              <span className="uppercase font-semibold tracking-wider text-slate-300">Distance to Support</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] bg-slate-800 text-cyan-300 border border-white/10 font-mono">
                ATR UNITS
              </span>
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-white">
                {formatDistanceAtr(riskDistanceAtr)}
              </div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Distance from latest close to nearest valid swing support in 14-day True Range units.
              </p>
              <div className="mt-2.5 pt-2.5 border-t border-white/5 text-[11px] text-slate-500">
                <span>Evaluated across the 252-bar lookback window.</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Full Levels Table */}
      {!isSuspended && (
        <div className="rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
          {/* Table Header & Source Filter */}
          <div className="p-4 border-b border-white/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-900/80">
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">All Identified Levels & References</h3>
              <span className="text-xs text-slate-400 font-mono">({filteredLevels.length})</span>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
              <button
                type="button"
                onClick={() => setSourceFilter("ALL")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "ALL"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("SWING")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "SWING"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                Swing Pivots
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("52W")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "52W"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                52-Week
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("AVERAGE")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "AVERAGE"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                Averages
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("ROUND")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "ROUND"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                Round Numbers
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("GAP")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "GAP"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                Gaps
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter("VOLUME_PROFILE")}
                className={`rounded px-2.5 py-1 text-xs font-mono font-medium transition ${
                  sourceFilter === "VOLUME_PROFILE"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                Volume Profile
              </button>
            </div>
          </div>

          {/* Table Content */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 border-b border-white/5 font-mono text-[11px]">
                <tr>
                  <th className="py-2.5 px-3">Level Price</th>
                  <th className="py-2.5 px-3">Side</th>
                  <th className="py-2.5 px-3">Source</th>
                  <th className="py-2.5 px-3 text-right">Distance (%)</th>
                  <th className="py-2.5 px-3 text-right">Distance (ATR)</th>
                  <th className="py-2.5 px-3 text-center">Touches</th>
                  <th className="py-2.5 px-3 text-center">State</th>
                  <th className="py-2.5 px-3">Date Range</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {filteredLevels.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-500 italic">
                      No levels found for the selected category.
                    </td>
                  </tr>
                ) : (
                  filteredLevels.map((l) => (
                    <tr key={l.id} className="hover:bg-white/[0.02] transition">
                      <td className="py-2.5 px-3 font-bold text-white whitespace-nowrap">
                        {formatCurrency(l.price)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                            l.side === "SUPPORT"
                              ? "bg-slate-800 text-sky-300 border-sky-500/30"
                              : "bg-slate-800 text-purple-300 border-purple-500/30"
                          }`}
                        >
                          {l.side}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                        {l.source}
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium text-slate-200 whitespace-nowrap">
                        {formatPercent(l.distancePct)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-300 whitespace-nowrap">
                        {formatDistanceAtr(l.distanceAtr)}
                      </td>
                      <td className="py-2.5 px-3 text-center text-slate-300 whitespace-nowrap">
                        {l.touches}
                        {l.strength > 0 && (
                          <span className="text-[10px] text-slate-500 ml-1">
                            ({l.strength.toFixed(2)})
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center whitespace-nowrap">
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                            l.state === "INTACT"
                              ? "text-slate-300 bg-slate-800/80"
                              : l.state === "BROKEN"
                                ? "text-amber-300 bg-amber-950/40 border border-amber-500/30"
                                : "text-sky-300 bg-sky-950/40 border border-sky-500/30"
                          }`}
                        >
                          {l.state}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                        {l.firstDate === l.lastDate
                          ? l.firstDate
                          : `${l.firstDate} → ${l.lastDate}`}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. "How these are calculated" Disclosure */}
      <div className="rounded-xl border border-white/10 bg-slate-900/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowFormulas(!showFormulas)}
          className="flex w-full items-center justify-between p-4 text-left text-xs font-semibold text-slate-300 hover:text-white transition"
        >
          <div className="flex items-center gap-2">
            <HelpCircle className="size-4 text-cyan-400" />
            <span>How these are calculated</span>
          </div>
          {showFormulas ? (
            <ChevronDown className="size-4 text-slate-400" />
          ) : (
            <ChevronRight className="size-4 text-slate-400" />
          )}
        </button>

        {showFormulas && (
          <div className="border-t border-white/5 p-4 text-xs text-slate-300 space-y-4">
            <p className="text-slate-400 leading-relaxed">
              Levels are descriptive reference points computed strictly from historical prices. They reflect past reaction points without directional projection.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="border-b border-white/10 text-slate-400 font-mono">
                  <tr>
                    <th className="py-2 pr-4">Reference</th>
                    <th className="py-2 pr-4">Formula & Definition</th>
                    <th className="py-2">Parameters Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-slate-300">
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Swing Pivot Clusters</td>
                    <td className="py-2 pr-4">
                      Highs/lows with half-window k=5 bars on each side. Linked into clusters when gap &le; 1.5%. Mean cluster price forms level.
                    </td>
                    <td className="py-2 text-slate-400">Lookback 252 bars, min 2 pivots, clusterGap 1.5%</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Recency Weight</td>
                    <td className="py-2 pr-4">
                      Each pivot weighted by exponential decay sum(0.5 ^ (age_bars / 126)). Older pivots contribute progressively less.
                    </td>
                    <td className="py-2 text-slate-400">Half-life 126 bars (~6 months)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Zone Half-Width</td>
                    <td className="py-2 pr-4">
                      w = max(1% &times; level, 0.5 &times; ATR14). Defines tolerance boundary around level price.
                    </td>
                    <td className="py-2 text-slate-400">zoneMinPct 1%, zoneAtrMultiple 0.5, ATR 14-day</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Side Classification</td>
                    <td className="py-2 pr-4">
                      Level below reference close is SUPPORT; level above reference close is RESISTANCE. Levels act bidirectionally.
                    </td>
                    <td className="py-2 text-slate-400">Evaluated against close_T</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Break & Flip Status</td>
                    <td className="py-2 pr-4">
                      BROKEN if close beyond level &plusmn; w occurred within 20 bars after pivot confirmed. FLIPPED if price currently trades on opposite side.
                    </td>
                    <td className="py-2 text-slate-400">brokenLookbackBars 20</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">52-Week High & Low</td>
                    <td className="py-2 pr-4">
                      Highest high and lowest low within trailing 365 calendar days.
                    </td>
                    <td className="py-2 text-slate-400">365 calendar days</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Moving Averages</td>
                    <td className="py-2 pr-4">
                      50-day and 200-day simple arithmetic mean of daily closing prices.
                    </td>
                    <td className="py-2 text-slate-400">50 and 200 trading bars</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Round Numbers</td>
                    <td className="py-2 pr-4">
                      Multiples of magnitude / 2 within &plusmn;15% of latest close price.
                    </td>
                    <td className="py-2 text-slate-400">Magnitude 10^floor(log10(P)), range 15%</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Unfilled Gaps</td>
                    <td className="py-2 pr-4">
                      Gaps &ge; 1.0 &times; ATR14 across lookback window where subsequent price action has not filled prior bar high/low.
                    </td>
                    <td className="py-2 text-slate-400">gapMinAtr 1.0, lookback 252 bars</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold text-white">Volume Profile</td>
                    <td className="py-2 pr-4">
                      60 equal price bins. Volume on each bar divided equally across bins spanned by high-low range. POC is heaviest bin; Value Area holds 70% volume.
                    </td>
                    <td className="py-2 text-slate-400">60 bins, valueAreaPct 70%</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {formulas && Object.keys(formulas).length > 0 && (
              <div className="pt-2 border-t border-white/5">
                <span className="text-[11px] text-slate-400 block mb-1">Source Formula Registry:</span>
                <div className="space-y-1 font-mono text-[10px] text-slate-400">
                  {Object.entries(formulas).map(([key, form]) => (
                    <div key={key}>
                      <span className="text-slate-300 font-semibold">{key}</span>: {form}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 5. Empirical Test Disclosure Note (Section 5.3) */}
      <div className="rounded-xl border border-white/10 bg-slate-900/30 p-4 text-xs text-slate-300 leading-relaxed">
        <div className="flex items-start gap-2">
          <Info className="size-4 text-slate-400 shrink-0 mt-0.5" />
          <span>{EQUITY_LEVELS_EMPIRICAL_NOTE}</span>
        </div>
      </div>

      {/* 6. Mandatory Disclaimer Footer */}
      <div className="border-t border-white/10 pt-4 text-center text-xs text-slate-500">
        <p>{EQUITY_LEVELS_DISCLAIMER}</p>
      </div>
    </div>
  );
}
