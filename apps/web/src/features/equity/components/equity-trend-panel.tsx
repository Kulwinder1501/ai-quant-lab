"use client";

import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  HelpCircle,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type {
  TrendMetricValue,
  TrendPanelResponse,
  WatchlistStockItem,
} from "../types";

export const EQUITY_TREND_DISCLAIMER =
  "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.";

interface EquityTrendPanelProps {
  trend: TrendPanelResponse | null;
  isLoading: boolean;
  error: string | null;
  stock: WatchlistStockItem;
}

export function EquityTrendPanel({
  trend,
  isLoading,
  error,
  stock,
}: EquityTrendPanelProps) {
  const [showFormulas, setShowFormulas] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <Loader2 className="size-8 animate-spin text-cyan-400" />
        <p className="mt-3 text-sm font-medium">Computing descriptive trend statistics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-6 text-rose-300">
        <div className="flex items-center gap-2 font-semibold">
          <AlertCircle className="size-5 text-rose-400" />
          <span>Unable to load trend statistics</span>
        </div>
        <p className="mt-2 text-sm text-rose-300/80">{error}</p>
      </div>
    );
  }

  if (!trend) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-400">
        <Info className="mx-auto size-8 text-slate-500" />
        <p className="mt-2 text-sm font-medium">No price bar data available for {stock.symbol}.</p>
        <p className="text-xs text-slate-500 mt-1">
          Historical bars are needed to calculate descriptive trend statistics.
        </p>
      </div>
    );
  }

  const { metrics, largeDailyMoves, asOfDate, isStale, staleDays, rebackfillNeeded } = trend;

  // Format return helper: Green / red ONLY for the sign of a return or drawdown (Plan Section 4)
  const formatReturnValue = (val: TrendMetricValue) => {
    if (val.state === "SUSPENDED") {
      return <span className="font-mono text-amber-300 text-xs">SUSPENDED</span>;
    }
    if (val.state === "INSUFFICIENT_HISTORY") {
      return <span className="font-mono text-slate-500 text-xs">INSUFFICIENT HISTORY</span>;
    }
    if (val.value === null) {
      return <span className="font-mono text-slate-500 text-xs">-</span>;
    }

    const isPositive = val.value > 0;
    const isNegative = val.value < 0;
    const textColor = isPositive
      ? "text-emerald-400"
      : isNegative
        ? "text-rose-400"
        : "text-slate-300";

    return (
      <span className={`font-mono text-base font-bold ${textColor}`}>
        {val.formatted}
      </span>
    );
  };

  // Format drawdown helper: Red for negative drawdown, neutral otherwise
  const formatDrawdownValue = (val: TrendMetricValue) => {
    if (val.state === "SUSPENDED") {
      return <span className="font-mono text-amber-300 text-xs">SUSPENDED</span>;
    }
    if (val.state === "INSUFFICIENT_HISTORY") {
      return <span className="font-mono text-slate-500 text-xs">INSUFFICIENT HISTORY</span>;
    }
    if (val.value === null) {
      return <span className="font-mono text-slate-500 text-xs">-</span>;
    }

    return (
      <span className="font-mono text-base font-bold text-rose-400">
        {val.formatted}
      </span>
    );
  };

  // Neutral number formatting for moving averages, volatility, volume ratio (Plan Section 4: neutral colors)
  const formatNeutralValue = (val: TrendMetricValue, unit = "") => {
    if (val.state === "SUSPENDED") {
      return <span className="font-mono text-amber-300 text-xs">SUSPENDED</span>;
    }
    if (val.state === "INSUFFICIENT_HISTORY") {
      return <span className="font-mono text-slate-500 text-xs">INSUFFICIENT HISTORY</span>;
    }
    if (val.state === "NOT_MEANINGFUL") {
      return <span className="font-mono text-slate-500 text-xs">NOT MEANINGFUL</span>;
    }
    if (val.value === null) {
      return <span className="font-mono text-slate-500 text-xs">-</span>;
    }

    return (
      <span className="font-mono text-base font-bold text-white">
        {val.formatted}
        {unit}
      </span>
    );
  };

  const renderWarnings = (warnings: string[]) => {
    if (!warnings || warnings.length === 0) return null;
    // Show the suspended message once in the banner and drop it from the individual cards
    if (rebackfillNeeded) return null;

    // Deduplicate and filter out redundant messages if already shown in banners
    const unique = Array.from(new Set(warnings)).filter((w) => {
      if (isStale && w.toLowerCase().includes("calendar days ago")) return false;
      return true;
    });
    if (unique.length === 0) return null;
    return (
      <div className="mt-2 space-y-1">
        {unique.map((w, idx) => (
          <div
            key={idx}
            className="flex items-start gap-1.5 rounded bg-amber-500/10 border border-amber-500/20 px-2 py-1 text-[11px] text-amber-300"
          >
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-400" />
            <span>{w}</span>
          </div>
        ))}
      </div>
    );
  };

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
          {stock.seriesVersion && stock.seriesVersion > 1 && (
            <span className="text-[11px] text-slate-500 font-mono">
              Series v{stock.seriesVersion}
            </span>
          )}
        </div>

        {/* Suspended Banner */}
        {rebackfillNeeded && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <RefreshCw className="size-4 shrink-0 mt-0.5 text-amber-400 animate-spin" />
            <div>
              <span className="font-bold block">Calculations Suspended: Re-backfill Needed</span>
              <span>
                Historical restatement or split detected in price series. Descriptive statistics will resume after full series re-backfill.
              </span>
            </div>
          </div>
        )}

        {/* Stale Banner */}
        {isStale && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <AlertTriangle className="size-4 shrink-0 mt-0.5 text-amber-400" />
            <div>
              <span className="font-bold block">Price Data Stale</span>
              <span>
                Price data is as of {asOfDate} ({staleDays} calendar days ago). Values describe past prices up to that date.
              </span>
            </div>
          </div>
        )}

        {/* Global Warnings - deduplicated and filtering out notices shown in banners */}
        {trend.warnings && (
          <div className="space-y-1">
            {Array.from(new Set(trend.warnings))
              .filter((w) => {
                if (isStale && w.toLowerCase().includes("calendar days ago")) return false;
                if (rebackfillNeeded && (w.toLowerCase().includes("corporate action") || w.toLowerCase().includes("re-synchronised") || w.toLowerCase().includes("re-backfill"))) return false;
                return true;
              })
              .map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 text-xs text-amber-400/90 font-mono"
                >
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* 2. Returns Row: 1M, 3M, 6M, YTD, 1Y */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Price Returns
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "1M Return", metric: metrics.return1M },
            { label: "3M Return", metric: metrics.return3M },
            { label: "6M Return", metric: metrics.return6M },
            { label: "YTD Return", metric: metrics.returnYTD },
            { label: "1Y Return", metric: metrics.return1Y },
          ].map((item, idx) => (
            <div
              key={idx}
              className="flex flex-col justify-between rounded-lg bg-slate-900/80 border border-white/5 p-3"
            >
              <div>
                <span className="block text-[11px] text-slate-400">{item.label}</span>
                <div className="mt-1">{formatReturnValue(item.metric)}</div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500 font-mono">
                {item.metric.barsUsed > 0 ? `${item.metric.barsUsed} bars` : "-"}
              </div>
              {renderWarnings(item.metric.warnings)}
            </div>
          ))}
        </div>
      </div>

      {/* 3. Averages Block */}
      <div className="rounded-xl border border-white/5 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Moving Averages
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">Latest Close</span>
            <div className="mt-1">{formatNeutralValue(metrics.latestClose, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              As of {metrics.latestClose.lastDateUsed ?? asOfDate ?? "—"}
            </span>
            {renderWarnings(metrics.latestClose.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">50-Day Average</span>
            <div className="mt-1">{formatNeutralValue(metrics.sma50, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              {metrics.distanceFromSma50.value !== null
                ? `${metrics.distanceFromSma50.formatted} from average`
                : "-"}
            </span>
            {renderWarnings(metrics.sma50.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">200-Day Average</span>
            <div className="mt-1">{formatNeutralValue(metrics.sma200, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              {metrics.distanceFromSma200.value !== null
                ? `${metrics.distanceFromSma200.formatted} from average`
                : "-"}
            </span>
            {renderWarnings(metrics.sma200.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">Comparison</span>
            <div className="mt-1 font-mono text-xs font-semibold text-cyan-300 leading-relaxed">
              {metrics.sma50VsSma200.formatted}
            </div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              50-day vs 200-day
            </span>
            {renderWarnings(metrics.sma50VsSma200.warnings)}
          </div>
        </div>
      </div>

      {/* 4. 52-Week Range Block */}
      <div className="rounded-xl border border-white/5 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          52-Week Range
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">52-Week Low</span>
            <div className="mt-1">{formatNeutralValue(metrics.low52W, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              {metrics.low52W.firstDateUsed ?? "-"}
            </span>
            {renderWarnings(metrics.low52W.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">52-Week High</span>
            <div className="mt-1">{formatNeutralValue(metrics.high52W, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              {metrics.high52W.lastDateUsed ?? "-"}
            </span>
            {renderWarnings(metrics.high52W.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">Range Position</span>
            <div className="mt-1">
              {metrics.position52W.value !== null ? (
                <span className="font-mono text-base font-bold text-white">
                  {(metrics.position52W.value * 100).toFixed(1)}%
                </span>
              ) : (
                <span className="font-mono text-xs text-slate-500">
                  {metrics.position52W.state}
                </span>
              )}
            </div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              0% = low, 100% = high
            </span>
            {renderWarnings(metrics.position52W.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">Distance from 52W High</span>
            <div className="mt-1">{formatNeutralValue(metrics.distanceFrom52WHigh, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              Relative to high
            </span>
            {renderWarnings(metrics.distanceFrom52WHigh.warnings)}
          </div>
        </div>

        {/* Visual Range Bar (Neutral colors per Plan Section 4) */}
        {metrics.position52W.value !== null && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono mb-1.5">
              <span>Low: {metrics.low52W.formatted}</span>
              <span className="text-cyan-300 font-semibold">
                Close: {metrics.latestClose.formatted} ({(metrics.position52W.value * 100).toFixed(1)}%)
              </span>
              <span>High: {metrics.high52W.formatted}</span>
            </div>
            <div className="relative h-2 w-full rounded-full bg-slate-800 border border-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-cyan-400 transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.max(0, metrics.position52W.value * 100))}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 5. Risk & Volatility Block */}
      <div className="rounded-xl border border-white/5 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Risk & Volatility
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs mb-3">
          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">20-Day Annualised Volatility</span>
            <div className="mt-1">{formatNeutralValue(metrics.volatility20D, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              Last 20 trading days
            </span>
            {renderWarnings(metrics.volatility20D.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">1-Year Annualised Volatility</span>
            <div className="mt-1">{formatNeutralValue(metrics.volatility1Y, "")}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              Last 252 daily returns
            </span>
            {renderWarnings(metrics.volatility1Y.warnings)}
          </div>

          <div className="rounded-lg bg-slate-950/40 p-3 border border-white/5">
            <span className="text-slate-400 block text-[11px]">1-Year Maximum Drawdown</span>
            <div className="mt-1">{formatDrawdownValue(metrics.maxDrawdown1Y)}</div>
            <span className="text-[10px] text-slate-500 font-mono block mt-1">
              Peak-to-trough in last 365 days
            </span>
            {renderWarnings(metrics.maxDrawdown1Y.warnings)}
          </div>
        </div>

        {/* Large Daily Moves List */}
        <div className="mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-medium text-slate-300">
              Large Daily Moves (&gt; 20% in single day)
            </span>
            <span className="font-mono text-xs text-slate-400">
              Count: <span className="font-bold text-white">{largeDailyMoves.length}</span> in last 252 returns
            </span>
          </div>

          {largeDailyMoves.length > 0 ? (
            <div className="divide-y divide-white/5 rounded-lg border border-white/5 bg-slate-950/40 overflow-hidden">
              {largeDailyMoves.map((m, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-3 py-2 text-xs font-mono"
                >
                  <span className="text-slate-300">{m.date}</span>
                  <span
                    className={`font-semibold ${
                      m.percentChange > 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {m.percentChange > 0 ? `+${m.percentChange.toFixed(2)}%` : `${m.percentChange.toFixed(2)}%`}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    ₹{m.previousClose.toFixed(2)} → ₹{m.close.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 font-mono">
              Zero daily moves exceeding ±20% recorded in the last 252 trading sessions.
            </p>
          )}
        </div>
      </div>

      {/* 6. Activity Block */}
      <div className="rounded-xl border border-white/5 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Activity
        </h3>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs">
          <div>
            <span className="text-slate-400 block text-[11px]">Relative Volume</span>
            <div className="mt-1">
              {formatNeutralValue(metrics.relativeActivity, "")}
            </div>
            <span className="text-[11px] text-slate-400 mt-1 block">
              20-day mean volume relative to 252-day mean volume.
            </span>
          </div>
          <div className="rounded bg-slate-950/60 border border-white/5 px-3 py-2 text-[11px] text-slate-400 max-w-sm">
            <span className="font-semibold text-slate-300 block mb-0.5">Note on Volume</span>
            Latest day volume is preliminary until the final market session settles.
          </div>
        </div>
        {renderWarnings(metrics.relativeActivity.warnings)}
      </div>

      {/* 8. "How these are calculated" Disclosure (Gate T5 / T6) */}
      <div className="rounded-xl border border-white/5 bg-slate-900/40 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowFormulas(!showFormulas)}
          className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-slate-300 hover:bg-white/5 transition"
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
          <div className="border-t border-white/5 p-4 space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">
              Formulas are computed as pure mathematical expressions over Yahoo Finance adjusted daily closes.
              Dividends and capital distributions are excluded from price returns.
            </p>
            <div className="divide-y divide-white/5 overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="text-slate-400 uppercase text-[10px] pb-2">
                    <th className="py-2 pr-3">Metric</th>
                    <th className="py-2 px-3">Formula</th>
                    <th className="py-2 px-3">Window</th>
                    <th className="py-2 px-3">Bars Used</th>
                    <th className="py-2 pl-3">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-slate-300">
                  {Object.entries(metrics).map(([key, val]) => (
                    <tr key={key} className="hover:bg-white/[0.02]">
                      <td className="py-2 pr-3 font-semibold text-cyan-300">{val.formulaId}</td>
                      <td className="py-2 px-3 text-slate-300">{val.formulaText}</td>
                      <td className="py-2 px-3 text-slate-400">{val.window}</td>
                      <td className="py-2 px-3 text-slate-400">{val.barsUsed}</td>
                      <td className="py-2 pl-3">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            val.state === "OK"
                              ? "bg-slate-800 text-slate-300"
                              : "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                          }`}
                        >
                          {val.state}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 7. Footer - Always Visible on every state (Gate T6) */}
      <div className="rounded-lg border border-white/5 bg-slate-950/60 p-3.5 text-center text-xs text-slate-400 leading-relaxed font-mono">
        {trend.disclaimer || EQUITY_TREND_DISCLAIMER}
      </div>
    </div>
  );
}
