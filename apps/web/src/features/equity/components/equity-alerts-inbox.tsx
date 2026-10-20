"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Bell,
  Check,
  CheckCheck,
  Filter,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { fetchEquityAlerts, updateAlertStatus } from "../api";
import {
  EQUITY_ALERT_FOOTER,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  type AlertStatus,
  type WatchlistStockItem,
} from "../types";

interface EquityAlertsInboxProps {
  isOpen: boolean;
  onClose: () => void;
  stocks: WatchlistStockItem[];
  selectedStockSymbol?: string;
  onAlertStatusChanged?: () => void;
}

export function EquityAlertsInbox({
  isOpen,
  onClose,
  stocks,
  selectedStockSymbol,
  onAlertStatusChanged,
}: EquityAlertsInboxProps) {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AlertStatus | "ALL">("ALL");
  const [stockFilter, setStockFilter] = useState<string>(selectedStockSymbol ?? "ALL");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [prevSelectedSymbol, setPrevSelectedSymbol] = useState(selectedStockSymbol);
  if (selectedStockSymbol !== prevSelectedSymbol) {
    setPrevSelectedSymbol(selectedStockSymbol);
    setStockFilter(selectedStockSymbol ?? "ALL");
  }

  const reloadAlerts = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const filter: {
        symbol?: string;
        status?: AlertStatus;
      } = {};

      if (stockFilter !== "ALL") {
        filter.symbol = stockFilter;
      }

      if (statusFilter !== "ALL") {
        filter.status = statusFilter;
      }

      const res = await fetchEquityAlerts(filter);
      setAlerts(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load alerts.";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [stockFilter, statusFilter]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const filter: {
      symbol?: string;
      status?: AlertStatus;
    } = {};

    if (stockFilter !== "ALL") {
      filter.symbol = stockFilter;
    }

    if (statusFilter !== "ALL") {
      filter.status = statusFilter;
    }

    void fetchEquityAlerts(filter)
      .then((res) => {
        if (isMounted) {
          setAlerts(res);
          setError(null);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load alerts.");
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, stockFilter, statusFilter]);

  const handleUpdateStatus = async (alertId: string, newStatus: AlertStatus) => {
    try {
      setUpdatingId(alertId);
      await updateAlertStatus(alertId, newStatus);
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, status: newStatus } : a)),
      );
      if (onAlertStatusChanged) {
        onAlertStatusChanged();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update alert state.";
      setError(msg);
    } finally {
      setUpdatingId(null);
    }
  };

  if (!isOpen) return null;

  const getKindBadgeClass = (kind: AlertKind) => {
    switch (kind) {
      case "LEVEL_BREAK":
        return "bg-rose-500/10 text-rose-300 border-rose-500/20";
      case "LEVEL_ZONE_ENTER":
        return "bg-amber-500/10 text-amber-300 border-amber-500/20";
      case "LEVEL_APPROACH":
        return "bg-cyan-500/10 text-cyan-300 border-cyan-500/20";
      case "NEW_52W_EXTREME":
        return "bg-purple-500/10 text-purple-300 border-purple-500/20";
      case "LARGE_MOVE":
        return "bg-blue-500/10 text-blue-300 border-blue-500/20";
      case "DATA_EVENT":
        return "bg-orange-500/10 text-orange-300 border-orange-500/20";
      case "DATA_HEALTH":
        return "bg-slate-500/10 text-slate-300 border-slate-500/20";
      default:
        return "bg-slate-500/10 text-slate-300 border-slate-500/20";
    }
  };

  const getSeverityBadgeClass = (severity: AlertSeverity) => {
    return severity === "NOTICE"
      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
      : "bg-slate-800 text-slate-300 border-white/10";
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm transition-opacity">
      <div className="flex h-full w-full max-w-xl flex-col bg-slate-950 border-l border-white/10 text-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-400 border border-cyan-500/20">
              <Bell className="size-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Equity Alerts</h2>
              <p className="text-xs text-slate-400">
                End-of-day alert events from daily bar evaluations
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reloadAlerts()}
              disabled={isLoading}
              className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white transition disabled:opacity-50"
              title="Refresh alerts"
            >
              <RefreshCw className={`size-4 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white transition"
              title="Close drawer"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-col gap-3 border-b border-white/5 bg-slate-900/40 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Status Filter Pills */}
            <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-lg border border-white/10">
              {(["ALL", "NEW", "SEEN", "DISMISSED"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    statusFilter === st
                      ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                      : "text-slate-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>

            {/* Stock Selector */}
            <div className="flex items-center gap-1.5">
              <Filter className="size-3.5 text-slate-400" />
              <select
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
                aria-label="Filter alerts by stock"
                className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              >
                <option value="ALL">All Stocks</option>
                {stocks.map((s) => (
                  <option key={s.id} value={s.symbol}>
                    {s.symbol} ({s.exchange})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Alert List Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Loading State */}
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-xl border border-white/5 bg-slate-900/40 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-24 bg-slate-800 rounded" />
                    <div className="h-4 w-16 bg-slate-800 rounded" />
                  </div>
                  <div className="h-4 w-3/4 bg-slate-800 rounded" />
                  <div className="h-10 w-full bg-slate-850 rounded" />
                </div>
              ))}
            </div>
          )}

          {/* Error State */}
          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 p-6 text-center text-rose-300">
              <AlertCircle className="size-8 text-rose-400 mb-2" />
              <h3 className="font-semibold text-white">Failed to load alerts</h3>
              <p className="text-xs text-slate-400 mt-1 mb-4">{error}</p>
              <button
                type="button"
                onClick={() => void reloadAlerts()}
                className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 transition border border-rose-500/30"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty State */}
          {!isLoading && !error && alerts.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-white/5 bg-slate-900/20 p-10 text-center">
              <div className="rounded-full bg-slate-900 p-3 text-slate-500 mb-3 border border-white/5">
                <CheckCheck className="size-6 text-slate-400" />
              </div>
              <h3 className="font-medium text-white text-sm">No alerts found</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-xs">
                {statusFilter !== "ALL" || stockFilter !== "ALL"
                  ? "No alerts match your current filter selections."
                  : "No alerts have fired for the active watchlist stocks."}
              </p>
              {(statusFilter !== "ALL" || stockFilter !== "ALL") && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter("ALL");
                    setStockFilter("ALL");
                  }}
                  className="mt-4 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 transition"
                >
                  Clear Filters
                </button>
              )}
            </div>
          )}

          {/* Populated State */}
          {!isLoading &&
            !error &&
            alerts.map((alert) => (
              <div
                key={alert.id}
                className="rounded-xl border border-white/10 bg-slate-900/70 p-4 transition hover:border-white/20"
              >
                {/* Meta Top Row */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {alert.symbol && (
                      <span className="font-mono text-xs font-bold text-white bg-slate-800 px-2 py-0.5 rounded border border-white/10">
                        {alert.symbol}
                      </span>
                    )}
                    <span
                      className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${getKindBadgeClass(
                        alert.kind,
                      )}`}
                    >
                      {alert.kind.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${getSeverityBadgeClass(
                        alert.severity,
                      )}`}
                    >
                      {alert.severity}
                    </span>
                  </div>

                  <span className="text-[11px] font-mono text-slate-400">
                    {alert.evaluated_date}
                  </span>
                </div>

                {/* Title (Descriptive Factual Sentence) */}
                <h4 className="text-sm font-medium text-slate-100 mb-2 leading-snug">
                  {alert.title}
                </h4>

                {/* Input Snapshot Metrics */}
                {alert.payload_json && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg bg-slate-950/60 p-2.5 text-[11px] text-slate-300 border border-white/5 mb-3">
                    {alert.payload_json.close !== undefined &&
                      alert.payload_json.close !== null && (
                        <div>
                          <span className="text-slate-500 block text-[10px]">
                            {alert.kind === "DATA_HEALTH" ? "Last close" : "Close"}
                          </span>
                          <span className="font-mono text-slate-200">
                            ₹{Number(alert.payload_json.close).toFixed(2)}
                          </span>
                        </div>
                      )}
                    {alert.payload_json.level !== undefined &&
                      alert.payload_json.level !== null && (
                        <div>
                          <span className="text-slate-500 block text-[10px]">Level</span>
                          <span className="font-mono text-slate-200">
                            ₹{Number(alert.payload_json.level).toFixed(2)}
                          </span>
                        </div>
                      )}
                    {alert.payload_json.atr !== undefined &&
                      alert.payload_json.atr !== null && (
                        <div>
                          <span className="text-slate-500 block text-[10px]">ATR14</span>
                          <span className="font-mono text-slate-200">
                            ₹{Number(alert.payload_json.atr).toFixed(2)}
                          </span>
                        </div>
                      )}
                    {alert.payload_json.seriesVersion !== undefined && (
                      <div>
                        <span className="text-slate-500 block text-[10px]">Version</span>
                        <span className="font-mono text-slate-200">
                          v{String(alert.payload_json.seriesVersion)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Status Actions */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2.5">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span
                      className={`inline-block size-2 rounded-full ${
                        alert.status === "NEW"
                          ? "bg-cyan-400"
                          : alert.status === "SEEN"
                          ? "bg-slate-400"
                          : "bg-slate-600"
                      }`}
                    />
                    <span className="font-medium text-[11px]">{alert.status}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {alert.status === "NEW" && (
                      <button
                        type="button"
                        disabled={updatingId === alert.id}
                        onClick={() => void handleUpdateStatus(alert.id, "SEEN")}
                        className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition border border-white/10 disabled:opacity-50"
                      >
                        <Check className="size-3" />
                        Mark as Seen
                      </button>
                    )}
                    {alert.status !== "DISMISSED" && (
                      <button
                        type="button"
                        disabled={updatingId === alert.id}
                        onClick={() => void handleUpdateStatus(alert.id, "DISMISSED")}
                        className="inline-flex items-center gap-1 rounded bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition border border-white/5 disabled:opacity-50"
                      >
                        <XCircle className="size-3" />
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>

                {/* Fixed Footer on Every Alert */}
                <div className="mt-2.5 border-t border-white/5 pt-2 text-[11px] text-slate-500 italic">
                  {EQUITY_ALERT_FOOTER}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
