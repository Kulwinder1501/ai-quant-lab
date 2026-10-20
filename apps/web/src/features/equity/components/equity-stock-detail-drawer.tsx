"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Calendar,
  Database,
  FileSpreadsheet,
  History,
  Info,
  Layers,
  Loader2,
  PieChart,
  RefreshCw,
  TrendingUp,
  X,
} from "lucide-react";
import type {
  EventFlagRecord,
  HistoryRange,
  LevelsPanelResponse,
  StockDetailResponse,
  TrendPanelResponse,
  WatchlistStockItem,
} from "../types";
import { fetchEquityEvents, fetchStockDetail, fetchStockLevels, fetchStockTrend } from "../api";
import { EquityChart } from "./equity-chart";
import { EquityTrendPanel } from "./equity-trend-panel";
import { EquityLevelsPanel } from "./equity-levels-panel";
import { EquityEventsPanel } from "./equity-events-panel";
import { ModalPortal } from "../../../components/ui/modal-portal";

interface EquityStockDetailDrawerProps {
  stock: WatchlistStockItem | null;
  isOpen: boolean;
  onClose: () => void;
}

type TabType = "trend" | "chart" | "levels" | "events" | "fundamentals" | "actions" | "logs";

export function EquityStockDetailDrawer({
  stock,
  isOpen,
  onClose,
}: EquityStockDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<TabType>("trend");
  const [range, setRange] = useState<HistoryRange>("1y");
  const [detail, setDetail] = useState<StockDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [trend, setTrend] = useState<TrendPanelResponse | null>(null);
  const [isTrendLoading, setIsTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);

  const [levels, setLevels] = useState<LevelsPanelResponse | null>(null);
  const [isLevelsLoading, setIsLevelsLoading] = useState(false);
  const [levelsError, setLevelsError] = useState<string | null>(null);

  const [events, setEvents] = useState<EventFlagRecord[]>([]);

  const loadStockEvents = useCallback(async () => {
    if (!stock) return;
    try {
      const data = await fetchEquityEvents({ stockId: stock.id });
      setEvents(data);
    } catch {
      // Best-effort for chart markers
    }
  }, [stock]);

  useEffect(() => {
    if (!isOpen || !stock) return;
    void loadStockEvents();
  }, [isOpen, stock, loadStockEvents]);

  // Defect 4: Accessibility - handle Escape key and lock body scroll
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  // Defect 9: Async effect without cascading synchronous setState
  useEffect(() => {
    if (!isOpen || !stock) return;

    let isMounted = true;
    const stockId = stock.id;

    void fetchStockDetail(stockId, range)
      .then((data) => {
        if (isMounted) {
          setDetail(data);
          setError(null);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load stock details.");
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, stock, range]);

  useEffect(() => {
    if (!isOpen || !stock) return;

    let isMounted = true;
    const stockId = stock.id;

    void fetchStockTrend(stockId)
      .then((data) => {
        if (isMounted) {
          setTrend(data);
          setTrendError(null);
          setIsTrendLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setTrendError(err instanceof Error ? err.message : "Failed to load trend statistics.");
          setIsTrendLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, stock]);

  useEffect(() => {
    if (!isOpen || !stock) return;

    let isMounted = true;
    const stockId = stock.id;

    void fetchStockLevels(stockId)
      .then((data) => {
        if (isMounted) {
          setLevels(data);
          setLevelsError(null);
          setIsLevelsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setLevelsError(err instanceof Error ? err.message : "Failed to load price levels.");
          setIsLevelsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, stock]);

  if (!isOpen || !stock) return null;

  const ranges: { label: string; value: HistoryRange }[] = [
    { label: "1M", value: "1mo" },
    { label: "3M", value: "3mo" },
    { label: "6M", value: "6mo" },
    { label: "1Y", value: "1y" },
    { label: "2Y", value: "2y" },
    { label: "5Y", value: "5y" },
    { label: "MAX", value: "max" },
  ];

  const formatCurrency = (val: number) => {
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatFundamentalValue = (val: number) => {
    if (Math.abs(val) >= 10000000) {
      const cr = val / 10000000;
      return `₹${cr.toFixed(2)} Cr (${val.toLocaleString("en-IN")})`;
    }
    return val.toLocaleString("en-IN");
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-sm animate-fadeIn"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equity-drawer-title"
      >
        <div
          className="fixed inset-0"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="absolute inset-y-0 right-0 flex max-w-full pl-0 sm:pl-10 pointer-events-none">
          <div className="w-screen max-w-3xl min-w-0 pointer-events-auto transform border-l border-white/10 bg-slate-950 text-slate-200 shadow-2xl transition-all duration-300 ease-in-out flex flex-col h-full overflow-hidden">
            {/* Drawer Header */}
            <div className="border-b border-white/10 p-4 sm:p-6 bg-slate-900/50 min-w-0">
              <div className="flex items-start justify-between gap-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2
                      id="equity-drawer-title"
                      className="text-xl font-bold text-white tracking-tight font-mono"
                    >
                      {stock.symbol}
                    </h2>
                    <span className="rounded bg-cyan-500/15 px-2 py-0.5 text-xs font-semibold text-cyan-300 border border-cyan-500/30 font-mono">
                      {stock.exchange}
                    </span>
                    <span className="text-xs text-slate-400 font-mono">
                      {stock.yahooSymbol}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-slate-300 truncate">
                    {stock.displayName}
                  </p>
                  {stock.note && (
                    <p className="text-xs text-cyan-400/80 italic mt-0.5 truncate">
                      Note: {stock.note}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white transition shrink-0"
                  aria-label="Close detail view"
                >
                  <X className="size-5" />
                </button>
              </div>

              {/* Quick Metrics Strip */}
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 text-xs">
                <div className="rounded-lg bg-slate-900/80 border border-white/5 p-2.5">
                  <span className="text-slate-400 block text-[11px]">Last Price</span>
                  <span className="text-sm font-bold text-white font-mono">
                    {stock.lastPrice !== null ? formatCurrency(stock.lastPrice) : "-"}
                  </span>
                </div>
                <div className="rounded-lg bg-slate-900/80 border border-white/5 p-2.5">
                  <span className="text-slate-400 block text-[11px]">Quote Label</span>
                  <span className="text-xs font-bold text-cyan-300 font-mono">
                    {stock.label ?? "PREVIOUS-CLOSE"}
                  </span>
                </div>
                <div className="rounded-lg bg-slate-900/80 border border-white/5 p-2.5">
                  <span className="text-slate-400 block text-[11px]">History Stored</span>
                  <span className="text-xs font-semibold text-slate-200 font-mono">
                    {stock.historyDepth.totalBars.toLocaleString()} bars
                  </span>
                </div>
                <div className="rounded-lg bg-slate-900/80 border border-white/5 p-2.5">
                  <span className="text-slate-400 block text-[11px]">Earliest Bar</span>
                  <span className="text-xs font-semibold text-slate-200 font-mono">
                    {stock.historyDepth.firstBarDate ?? "N/A"}
                  </span>
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="mt-4 sm:mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between border-t border-white/5 pt-3 gap-2 min-w-0">
                <div className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0 py-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab("trend")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "trend"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Activity className="size-3.5" />
                    Trend
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("levels")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "levels"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Layers className="size-3.5" />
                    Levels
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("chart")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "chart"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <TrendingUp className="size-3.5" />
                    Price Chart
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("events")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "events"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Calendar className="size-3.5" />
                    Events
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("fundamentals")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "fundamentals"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <FileSpreadsheet className="size-3.5" />
                    Secondary Fundamentals
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("actions")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "actions"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <PieChart className="size-3.5" />
                    Actions & Revisions
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("logs")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0 whitespace-nowrap transition ${
                      activeTab === "logs"
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <History className="size-3.5" />
                    Collection Logs
                  </button>
                </div>

                {activeTab === "chart" && (
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 p-0.5 overflow-x-auto min-w-0 shrink-0">
                    {ranges.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setRange(r.value)}
                        disabled={isLoading}
                        className={`rounded px-2 py-0.5 text-[11px] font-mono font-semibold transition ${
                          range === r.value
                            ? "bg-cyan-500/20 text-cyan-300"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 scrollbar-thin scrollbar-thumb-white/10 min-w-0">
              {activeTab === "trend" ? (
                <EquityTrendPanel
                  stock={stock}
                  trend={trend}
                  isLoading={isTrendLoading}
                  error={trendError}
                />
              ) : activeTab === "levels" ? (
                <EquityLevelsPanel
                  stock={stock}
                  levelsData={levels}
                  isLoading={isLevelsLoading}
                  error={levelsError}
                />
              ) : activeTab === "events" ? (
                <EquityEventsPanel
                  stock={stock}
                  onEventCreated={loadStockEvents}
                />
              ) : isLoading && !detail ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
                  <Loader2 className="size-8 animate-spin text-cyan-400" />
                  <span className="text-xs">Loading stock details and price bars...</span>
                </div>
              ) : error ? (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertCircle className="size-4 text-rose-400" />
                    <span>Error Loading Details</span>
                  </div>
                  <p className="mt-1">{error}</p>
                </div>
              ) : detail ? (
                <div className="space-y-6">
                  {/* TAB 1: CHART & SUMMARY */}
                  {activeTab === "chart" && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>
                          Showing <span className="font-bold text-white">{detail.priceBars.length}</span> daily bars ({range})
                        </span>
                        {isLoading && (
                          <span className="text-cyan-400 flex items-center gap-1">
                            <RefreshCw className="size-3 animate-spin" /> Updating range...
                          </span>
                        )}
                      </div>

                      {stock.rebackfillNeeded || stock.state === "REBACKFILL_NEEDED" ? (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-8 text-center space-y-3">
                          <AlertTriangle className="size-8 text-amber-400 mx-auto" />
                          <h4 className="text-sm font-semibold text-amber-300">
                            Chart Suspended: Series Re-Backfill Required
                          </h4>
                          <p className="text-xs text-amber-200/80 max-w-md mx-auto">
                            A historical price restatement or corporate action was detected for {stock.symbol}.
                            Price chart rendering is suspended until the full history is synchronized to prevent displaying inconsistent scales.
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3 shadow-inner">
                          <EquityChart
                            bars={detail.priceBars}
                            currency={stock.currency}
                            className="h-[380px] w-full"
                            levels={levels?.levels}
                            events={events}
                          />
                        </div>
                      )}

                      {/* Bar Summary Details */}
                      <div className="rounded-xl border border-white/5 bg-slate-900/40 p-4 text-xs space-y-2">
                        <h4 className="font-semibold text-slate-200 flex items-center gap-1.5">
                          <Database className="size-4 text-cyan-400" />
                          Storage Invariants & Range Meta
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-slate-400 font-mono">
                          <div>
                            <span>Range First Bar: </span>
                            <span className="text-slate-200">
                              {detail.priceBars[0]?.barDate ?? "N/A"}
                            </span>
                          </div>
                          <div>
                            <span>Range Last Bar: </span>
                            <span className="text-slate-200">
                              {detail.priceBars[detail.priceBars.length - 1]?.barDate ?? "N/A"}
                            </span>
                          </div>
                          <div>
                            <span>Total In DB: </span>
                            <span className="text-slate-200">{detail.summary.totalBars}</span>
                          </div>
                          <div>
                            <span>Data Gap (&gt;10d): </span>
                            <span className={detail.summary.hasDataGap ? "text-amber-400" : "text-emerald-400"}>
                              {detail.summary.hasDataGap ? "Yes" : "No"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: SECONDARY FUNDAMENTALS */}
                  {activeTab === "fundamentals" && (
                    <div className="space-y-4">
                      {/* Mandatory Headings & Basis Notice (Gate G2, Spec Requirement) */}
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs space-y-2">
                        <div className="flex items-center gap-2">
                          <Info className="size-4 text-amber-400" />
                          <h3 className="font-bold text-amber-200 text-sm tracking-wide uppercase">
                            Secondary, from Yahoo, not verified
                          </h3>
                        </div>
                        <p className="text-amber-300/90 leading-relaxed font-sans">
                          Basis (consolidated/standalone) is recorded as UNKNOWN because Yahoo does not report basis.
                        </p>
                        <p className="text-[11px] text-slate-400 italic">
                          These metrics are collected as secondary reference points only and are not reconciled against official XBRL exchange filings.
                        </p>
                      </div>

                      {detail.secondaryFundamentals.facts.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-400">
                          No secondary fundamentals recorded yet for this stock.
                        </div>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden shadow-lg">
                          <table className="w-full text-left text-xs">
                            <thead className="border-b border-white/10 bg-slate-950/80 font-semibold text-slate-400 uppercase tracking-wider">
                              <tr>
                                <th className="py-3 pl-4 pr-3">Metric Item</th>
                                <th className="px-3 py-3">Period</th>
                                <th className="px-3 py-3">Period End</th>
                                <th className="px-3 py-3">Reported Value</th>
                                <th className="px-3 py-3">Basis</th>
                                <th className="py-3 pl-3 pr-4 text-right">First Seen</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 font-mono">
                              {detail.secondaryFundamentals.facts.map((fact, idx) => (
                                <tr key={idx} className="hover:bg-white/[0.02]">
                                  <td className="py-3 pl-4 pr-3 font-sans font-medium text-slate-200">
                                    {fact.item}
                                  </td>
                                  <td className="px-3 py-3 text-slate-400">{fact.periodType}</td>
                                  <td className="px-3 py-3 text-slate-300">{fact.periodEnd}</td>
                                  <td className="px-3 py-3 font-semibold text-white">
                                    {formatFundamentalValue(fact.value)}
                                  </td>
                                  <td className="px-3 py-3">
                                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-500/20 font-sans">
                                      {fact.basis}
                                    </span>
                                  </td>
                                  <td className="py-3 pl-3 pr-4 text-right text-slate-500 text-[11px]">
                                    {fact.firstSeenAt.split("T")[0]}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 3: CORPORATE ACTIONS & REVISIONS */}
                  {activeTab === "actions" && (
                    <div className="space-y-6">
                      {/* Dividends & Splits */}
                      <div className="space-y-3">
                        <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                          <PieChart className="size-4 text-cyan-400" />
                          Dividends & Splits
                        </h4>
                        {detail.corporateActions.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-400">
                            No corporate actions recorded.
                          </div>
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden shadow-lg">
                            <table className="w-full text-left text-xs">
                              <thead className="border-b border-white/10 bg-slate-950/80 font-semibold text-slate-400 uppercase tracking-wider">
                                <tr>
                                  <th className="py-3 pl-4 pr-3">Action Type</th>
                                  <th className="px-3 py-3">Date</th>
                                  <th className="px-3 py-3">Value / Amount</th>
                                  <th className="py-3 pl-3 pr-4 text-right">Remarks</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5 font-mono">
                                {detail.corporateActions.map((act) => (
                                  <tr key={act.id} className="hover:bg-white/[0.02]">
                                    <td className="py-3 pl-4 pr-3">
                                      <span
                                        className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                                          act.actionType === "DIVIDEND"
                                            ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20"
                                            : "bg-blue-500/15 text-blue-300 border border-blue-500/20"
                                        }`}
                                      >
                                        {act.actionType}
                                      </span>
                                    </td>
                                    <td className="px-3 py-3 text-slate-300">{act.actionDate}</td>
                                    <td className="px-3 py-3 font-semibold text-white">
                                      {act.actionType === "DIVIDEND" ? `₹${act.value.toFixed(2)}` : act.value}
                                    </td>
                                    <td className="py-3 pl-3 pr-4 text-right text-slate-400 font-sans">
                                      {act.remarks ?? "-"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Price Bar Revisions (Gate S4) */}
                      <div className="space-y-3 border-t border-white/10 pt-5">
                        <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                          <History className="size-4 text-cyan-400" />
                          Price Bar Revisions (Restatements Captured)
                        </h4>
                        <p className="text-xs text-slate-400">
                          When Yahoo revises previously published daily volume or close prices, revisions are recorded here rather than silently overwriting historical bars.
                        </p>
                        {detail.revisions.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-400">
                            Zero restatements. Original bar values remain unchanged.
                          </div>
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden shadow-lg">
                            <table className="w-full text-left text-xs">
                              <thead className="border-b border-white/10 bg-slate-950/80 font-semibold text-slate-400 uppercase tracking-wider">
                                <tr>
                                  <th className="py-3 pl-4 pr-3">Bar Date</th>
                                  <th className="px-3 py-3">Previous Values</th>
                                  <th className="px-3 py-3">New Revised Values</th>
                                  <th className="py-3 pl-3 pr-4 text-right">Detected At</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5 font-mono">
                                {detail.revisions.map((rev, idx) => (
                                  <tr key={idx} className="hover:bg-white/[0.02]">
                                    <td className="py-3 pl-4 pr-3 font-semibold text-white">
                                      {rev.barDate}
                                    </td>
                                    <td className="px-3 py-3 text-rose-300">
                                      {JSON.stringify(rev.previousValues)}
                                    </td>
                                    <td className="px-3 py-3 text-emerald-300">
                                      {JSON.stringify(rev.newValues)}
                                    </td>
                                    <td className="py-3 pl-3 pr-4 text-right text-slate-500 text-[11px]">
                                      {new Date(rev.seenAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: COLLECTION LOGS */}
                  {activeTab === "logs" && (
                    <div className="space-y-3">
                      <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                        <History className="size-4 text-cyan-400" />
                        Collection & Raw Record Audit
                      </h4>
                      <p className="text-xs text-slate-400">
                        Recent raw fetch records landed in <code className="text-cyan-300 font-mono">equity_research.raw_record</code> for this stock.
                      </p>

                      {detail.collectionLogs.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-400">
                          No collection logs found for this symbol.
                        </div>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden shadow-lg">
                          <table className="w-full text-left text-xs font-mono">
                            <thead className="border-b border-white/10 bg-slate-950/80 font-semibold text-slate-400 uppercase tracking-wider">
                              <tr>
                                <th className="py-3 pl-4 pr-3">Timestamp</th>
                                <th className="px-3 py-3">Endpoint</th>
                                <th className="px-3 py-3">Status</th>
                                <th className="px-3 py-3">Outcome</th>
                                <th className="py-3 pl-3 pr-4 text-right">Warnings</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {detail.collectionLogs.map((log) => (
                                <tr key={log.id} className="hover:bg-white/[0.02]">
                                  <td className="py-3 pl-4 pr-3 text-slate-300">
                                    {new Date(log.requestedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                                  </td>
                                  <td className="px-3 py-3 text-cyan-400">{log.endpoint}</td>
                                  <td className="px-3 py-3 text-slate-200">{log.httpStatus}</td>
                                  <td className="px-3 py-3">
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                        log.outcome === "OK"
                                          ? "bg-emerald-500/15 text-emerald-300"
                                          : "bg-rose-500/15 text-rose-300"
                                      }`}
                                    >
                                      {log.outcome}
                                    </span>
                                  </td>
                                  <td className="py-3 pl-3 pr-4 text-right text-slate-400 font-sans">
                                    {log.warnings.length > 0 ? log.warnings.join(", ") : "-"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
