"use client";

import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, ShieldAlert, XCircle } from "lucide-react";

interface EquityHeaderProps {
  totalCount: number;
  sourceStatus: string;
  lastRefreshedAt: Date | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export function EquityHeader({
  totalCount,
  sourceStatus,
  lastRefreshedAt,
  isLoading,
  onRefresh,
}: EquityHeaderProps) {
  const getSourceBadge = (status: string) => {
    switch (status) {
      case "OK":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="size-3.5" />
            Yahoo Finance: OK
          </span>
        );
      case "DEGRADED":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <AlertTriangle className="size-3.5" />
            Yahoo Finance: Degraded
          </span>
        );
      case "UNAVAILABLE":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <XCircle className="size-3.5" />
            Yahoo Finance: Unavailable
          </span>
        );
      case "RATE_LIMITED":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20">
            <ShieldAlert className="size-3.5" />
            Yahoo Finance: Rate-Limited (Cooldown)
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-500/10 text-slate-400 border border-slate-500/20">
            <Activity className="size-3.5" />
            Yahoo Finance: {status || "Unknown"}
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col gap-4 border-b border-white/10 pb-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">Equity Watch</h1>
            <span className="rounded-md bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-400 border border-cyan-500/20">
              {totalCount} / 50 Stocks
            </span>
            {getSourceBadge(sourceStatus)}
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Automated EOD price collection, 20-year history backfill & secondary fundamentals.
          </p>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto">
          {lastRefreshedAt && (
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Clock className="size-3.5" />
              Updated {lastRefreshedAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/5 hover:text-white disabled:opacity-50"
            title="Refresh watchlist"
          >
            <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 bg-slate-900/40 border border-white/5 px-3 py-2 rounded-lg">
        <span className="text-cyan-400 font-semibold uppercase tracking-wider text-[10px]">Quote Policy:</span>
        <span>Quotes are marked</span>
        <span className="font-mono text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">DELAYED</span>
        <span>during market hours or</span>
        <span className="font-mono text-slate-300 bg-slate-800 px-1.5 py-0.5 rounded border border-white/10">PREVIOUS-CLOSE</span>
        <span>outside market hours. Never claimed as real-time.</span>
      </div>
    </div>
  );
}
