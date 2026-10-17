"use client";

import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Calendar,
  CheckCircle,
  Clock,
  Eye,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { EquityStockState, PriceQuoteLabel, WatchlistStockItem } from "../types";

interface EquityWatchlistTableProps {
  stocks: WatchlistStockItem[];
  isLoading: boolean;
  hasError?: boolean;
  onSelectStock: (stock: WatchlistStockItem) => void;
  onRemoveStock: (stock: WatchlistStockItem) => void;
}

export function EquityWatchlistTable({
  stocks,
  isLoading,
  hasError = false,
  onSelectStock,
  onRemoveStock,
}: EquityWatchlistTableProps) {
  const renderQuoteLabel = (label: PriceQuoteLabel | null) => {
    switch (label) {
      case "DELAYED":
        return (
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20">
            <Clock className="size-3" />
            DELAYED
          </span>
        );
      case "LAST-TRADED":
        return (
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
            <Clock className="size-3" />
            LAST-TRADED
          </span>
        );
      case "PREVIOUS-CLOSE":
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-slate-800 text-slate-300 border border-white/10">
            <Calendar className="size-3" />
            PREV-CLOSE
          </span>
        );
    }
  };

  const renderStateBadge = (state: EquityStockState, reason: string | null) => {
    switch (state) {
      case "REBACKFILL_NEEDED":
        return (
          <div className="flex flex-col">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 w-fit"
              title={reason ?? "Historical restatement or corporate action detected; series re-backfill pending"}
            >
              <RefreshCw className="size-3 animate-spin" />
              REBACKFILL
            </span>
            {reason && <span className="text-[10px] text-amber-400/80 mt-0.5 line-clamp-1">{reason}</span>}
          </div>
        );
      case "OK":
        return (
          <div className="flex flex-col">
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 w-fit">
              <CheckCircle className="size-3" />
              OK
            </span>
          </div>
        );
      case "STALE":
        return (
          <div className="flex flex-col">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20 w-fit"
              title={reason ?? "Price bar is older than 4 calendar days (stale collection)"}
            >
              <AlertTriangle className="size-3" />
              STALE
            </span>
            {reason && <span className="text-[10px] text-amber-400/80 mt-0.5 line-clamp-1">{reason}</span>}
          </div>
        );
      case "UNAVAILABLE":
        return (
          <div className="flex flex-col">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-rose-500/10 text-rose-300 border border-rose-500/20 w-fit"
              title={reason ?? "Upstream fetch error"}
            >
              <AlertCircle className="size-3" />
              UNAVAILABLE
            </span>
            {reason && <span className="text-[10px] text-rose-400/80 mt-0.5 line-clamp-1">{reason}</span>}
          </div>
        );
      case "RATE_LIMITED":
        return (
          <div className="flex flex-col">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-purple-500/10 text-purple-300 border border-purple-500/20 w-fit"
              title={reason ?? "Yahoo Finance rate limit cooldown"}
            >
              <AlertCircle className="size-3" />
              RATE_LIMITED
            </span>
            {reason && <span className="text-[10px] text-purple-400/80 mt-0.5 line-clamp-1">{reason}</span>}
          </div>
        );
      case "NEVER_FETCHED":
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-slate-800 text-slate-400 border border-white/10 w-fit">
            NEVER_FETCHED
          </span>
        );
    }
  };

  const formatAsOfTime = (isoString: string | null) => {
    if (!isoString) return "-";
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    } catch {
      return isoString;
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/40 p-6 backdrop-blur-md">
        <div className="space-y-4">
          <div className="h-6 w-48 rounded bg-white/5 animate-pulse" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-white/5 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Defect 2 Fix: A failed load is NOT an empty list!
  if (hasError) {
    return null;
  }

  if (stocks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/15 bg-slate-900/30 p-12 text-center backdrop-blur-md">

        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 mb-4">
          <BarChart2 className="size-7" />
        </div>
        <h3 className="text-lg font-bold text-white mb-1">Your Watchlist is Empty</h3>
        <p className="max-w-md mx-auto text-sm text-slate-400 mb-6">
          Add your first stock above (for example <code className="text-cyan-300 font-semibold">SUZLON</code> on NSE) to begin tracking daily closing bars, corporate actions, and secondary fundamentals.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 shadow-xl backdrop-blur-md overflow-hidden">
      <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-white/10">
        <table className="w-full text-left text-sm text-slate-200">
          <thead className="border-b border-white/10 bg-slate-950/60 text-xs font-semibold text-slate-400 uppercase tracking-wider">
            <tr>
              <th scope="col" className="py-3.5 pl-4 pr-3 sm:pl-6">Stock</th>
              <th scope="col" className="px-3 py-3.5">Price</th>
              <th scope="col" className="px-3 py-3.5">Change %</th>
              <th scope="col" className="hidden md:table-cell px-3 py-3.5">1M</th>
              <th scope="col" className="hidden md:table-cell px-3 py-3.5">1Y</th>
              <th scope="col" className="hidden md:table-cell px-3 py-3.5">52W Position</th>
              <th scope="col" className="hidden lg:table-cell px-3 py-3.5">As Of</th>
              <th scope="col" className="hidden sm:table-cell px-3 py-3.5">Label</th>
              <th scope="col" className="px-3 py-3.5">State</th>
              <th scope="col" className="hidden xl:table-cell px-3 py-3.5">History Depth</th>
              <th scope="col" className="hidden xl:table-cell px-3 py-3.5">Data Gap</th>
              <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {stocks.map((stock) => (
              <tr
                key={stock.id}
                className="group hover:bg-white/[0.03] transition-colors cursor-pointer"
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (!target.closest("button")) {
                    onSelectStock(stock);
                  }
                }}
              >
                {/* Stock Symbol, Exchange & Name */}
                <td className="py-4 pl-4 pr-3 sm:pl-6">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-base text-white group-hover:text-cyan-300 transition-colors">
                        {stock.symbol}
                      </span>
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 border border-white/10 font-mono">
                        {stock.exchange}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 line-clamp-1 max-w-[200px]" title={stock.displayName}>
                      {stock.displayName}
                    </span>
                    {stock.note && (
                      <span className="text-[11px] text-cyan-400/80 italic mt-0.5">
                        {stock.note}
                      </span>
                    )}
                  </div>
                </td>

                {/* Last Price */}
                <td className="whitespace-nowrap px-3 py-4">
                  <span className="font-mono text-sm font-semibold text-white">
                    {stock.lastPrice !== null ? `₹${stock.lastPrice.toFixed(2)}` : "-"}
                  </span>
                </td>

                {/* Change % */}
                <td className="whitespace-nowrap px-3 py-4">
                  {stock.changePercent !== null ? (
                    <span
                      className={`inline-flex items-center gap-0.5 font-mono text-xs font-semibold ${
                        stock.changePercent > 0
                          ? "text-emerald-400"
                          : stock.changePercent < 0
                            ? "text-rose-400"
                            : "text-slate-400"
                      }`}
                    >
                      {stock.changePercent > 0 ? (
                        <ArrowUpRight className="size-3.5" />
                      ) : stock.changePercent < 0 ? (
                        <ArrowDownRight className="size-3.5" />
                      ) : null}
                      {stock.changePercent > 0 ? "+" : ""}
                      {stock.changePercent.toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-slate-500 font-mono text-xs">-</span>
                  )}
                </td>

                {/* 1M Return (Slice 1) */}
                <td className="whitespace-nowrap px-3 py-4 hidden md:table-cell">
                  {stock.state === "REBACKFILL_NEEDED" || stock.trendSummary?.state === "SUSPENDED" ? (
                    <span className="inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 font-mono">
                      SUSPENDED
                    </span>
                  ) : stock.trendSummary?.state === "INSUFFICIENT_HISTORY" || stock.trendSummary?.return1M === null || stock.trendSummary?.return1M === undefined ? (
                    <span className="text-slate-500 font-mono text-xs">-</span>
                  ) : (
                    <div className="flex flex-col">
                      <span
                        className={`font-mono text-xs font-semibold ${
                          stock.trendSummary.return1M > 0
                            ? "text-emerald-400"
                            : stock.trendSummary.return1M < 0
                              ? "text-rose-400"
                              : "text-slate-300"
                        }`}
                      >
                        {stock.trendSummary.return1M > 0 ? "+" : ""}
                        {(stock.trendSummary.return1M * 100).toFixed(2)}%
                      </span>
                      {(stock.state === "STALE" || stock.trendSummary.isStale) && stock.trendSummary.asOfDate && (
                        <span className="text-[10px] text-amber-400/90 font-mono" title={`Stale data as of ${stock.trendSummary.asOfDate}`}>
                          as of {stock.trendSummary.asOfDate}
                        </span>
                      )}
                    </div>
                  )}
                </td>

                {/* 1Y Return (Slice 1) */}
                <td className="whitespace-nowrap px-3 py-4 hidden md:table-cell">
                  {stock.state === "REBACKFILL_NEEDED" || stock.trendSummary?.state === "SUSPENDED" ? (
                    <span className="inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 font-mono">
                      SUSPENDED
                    </span>
                  ) : stock.trendSummary?.state === "INSUFFICIENT_HISTORY" || stock.trendSummary?.return1Y === null || stock.trendSummary?.return1Y === undefined ? (
                    <span className="text-slate-500 font-mono text-xs">-</span>
                  ) : (
                    <div className="flex flex-col">
                      <span
                        className={`font-mono text-xs font-semibold ${
                          stock.trendSummary.return1Y > 0
                            ? "text-emerald-400"
                            : stock.trendSummary.return1Y < 0
                              ? "text-rose-400"
                              : "text-slate-300"
                        }`}
                      >
                        {stock.trendSummary.return1Y > 0 ? "+" : ""}
                        {(stock.trendSummary.return1Y * 100).toFixed(2)}%
                      </span>
                      {(stock.state === "STALE" || stock.trendSummary.isStale) && stock.trendSummary.asOfDate && (
                        <span className="text-[10px] text-amber-400/90 font-mono" title={`Stale data as of ${stock.trendSummary.asOfDate}`}>
                          as of {stock.trendSummary.asOfDate}
                        </span>
                      )}
                    </div>
                  )}
                </td>

                {/* 52W Position Bar (Slice 1 - Neutral styling per plan) */}
                <td className="whitespace-nowrap px-3 py-4 hidden md:table-cell">
                  {stock.state === "REBACKFILL_NEEDED" || stock.trendSummary?.state === "SUSPENDED" ? (
                    <span className="inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 font-mono">
                      SUSPENDED
                    </span>
                  ) : stock.trendSummary?.position52W !== null && stock.trendSummary?.position52W !== undefined ? (
                    <div className="flex flex-col gap-1 w-24">
                      <div className="flex items-center justify-between text-[10px] text-slate-300 font-mono">
                        <span>{(stock.trendSummary.position52W * 100).toFixed(0)}%</span>
                        {(stock.state === "STALE" || stock.trendSummary.isStale) && (
                          <span className="text-amber-400 text-[9px]">stale</span>
                        )}
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 border border-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-cyan-400"
                          style={{
                            width: `${Math.min(100, Math.max(0, stock.trendSummary.position52W * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-slate-500 font-mono text-xs">-</span>
                  )}
                </td>

                {/* As Of Date */}
                <td className="whitespace-nowrap px-3 py-4 text-xs text-slate-400 font-mono hidden lg:table-cell">
                  {formatAsOfTime(stock.asOf)}
                </td>

                {/* Honest Quote Label (Gate G3) */}
                <td className="whitespace-nowrap px-3 py-4 hidden sm:table-cell">
                  {renderQuoteLabel(stock.label)}
                </td>

                {/* Stock State (Gate S8) */}
                <td className="whitespace-nowrap px-3 py-4">
                  {renderStateBadge(stock.state, stock.stateReason)}
                </td>

                {/* History Depth */}
                <td className="whitespace-nowrap px-3 py-4 hidden xl:table-cell">
                  <div className="flex flex-col text-xs font-mono">
                    <span className="text-slate-200">
                      {stock.historyDepth.totalBars.toLocaleString()} bars
                    </span>
                    <span className="text-[10px] text-slate-500">
                      Since {stock.historyDepth.firstBarDate ?? "N/A"}
                    </span>
                  </div>
                </td>

                {/* Data Gap Flag */}
                <td className="whitespace-nowrap px-3 py-4 hidden xl:table-cell">
                  {stock.hasDataGap ? (
                    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20">
                      <AlertTriangle className="size-3" />
                      Gap (&gt;10d)
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      <CheckCircle className="size-3" />
                      Clean
                    </span>
                  )}
                </td>

                {/* Actions */}
                <td className="whitespace-nowrap py-4 pl-3 pr-4 sm:pr-6 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectStock(stock)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-800/80 px-2.5 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition"
                      title="View chart & secondary fundamentals"
                    >
                      <Eye className="size-3.5" />
                      Detail
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveStock(stock)}
                      className="inline-flex items-center justify-center size-8 rounded-lg border border-white/10 bg-slate-800/80 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30 transition"
                      title="Remove from watchlist"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
