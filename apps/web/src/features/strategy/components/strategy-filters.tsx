import React from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface StrategyFiltersProps {
  symbolFilter: string;
  setSymbolFilter: (v: string) => void;
  sideFilter: string;
  setSideFilter: (v: string) => void;
  minConfidence: number;
  setMinConfidence: (v: number) => void;
  dateFilter: string;
  setDateFilter: (v: string) => void;
  includeExpired: boolean;
  setIncludeExpired: (v: boolean) => void;
  loading: boolean;
  onRefresh: () => void;
  onGenerate: () => void;
}

export function StrategyFilters({
  symbolFilter,
  setSymbolFilter,
  sideFilter,
  setSideFilter,
  minConfidence,
  setMinConfidence,
  dateFilter,
  setDateFilter,
  includeExpired,
  setIncludeExpired,
  loading,
  onRefresh,
  onGenerate,
}: StrategyFiltersProps) {
  return (
    <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <label htmlFor="filter-sym" className="text-xs font-semibold text-slate-400">
            Symbol:
          </label>
          <select
            id="filter-sym"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            className="bg-transparent text-sm font-semibold text-white focus:outline-none w-auto cursor-pointer"
          >
            <option value="" className="bg-slate-900 text-white">All Symbols</option>
            <option value="NIFTY50" className="bg-slate-900 text-white">NIFTY 50</option>
            <option value="BANKNIFTY" className="bg-slate-900 text-white">NIFTY BANK</option>
          </select>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <label htmlFor="filter-side" className="text-xs font-semibold text-slate-400">
            Side:
          </label>
          <select
            id="filter-side"
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value)}
            className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer"
          >
            <option value="ALL" className="bg-slate-900 text-white">All Sides</option>
            <option value="LONG" className="bg-slate-900 text-emerald-300">LONG</option>
            <option value="SHORT" className="bg-slate-900 text-rose-300">SHORT</option>
          </select>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <label htmlFor="filter-conf" className="text-xs font-semibold text-slate-400">
            Min Conf:
          </label>
          <select
            id="filter-conf"
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer"
          >
            <option value={0} className="bg-slate-900 text-white">Any (0%)</option>
            <option value={0.5} className="bg-slate-900 text-white">&ge; 50%</option>
            <option value={0.65} className="bg-slate-900 text-white">&ge; 65%</option>
            <option value={0.8} className="bg-slate-900 text-white">&ge; 80%</option>
          </select>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <label htmlFor="filter-date" className="text-xs font-semibold text-slate-400">
            Date:
          </label>
          <input
            id="filter-date"
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="bg-transparent text-sm font-semibold text-white focus:outline-none w-auto cursor-pointer placeholder:text-slate-600"
          />
        </div>

        <label className="flex items-center gap-2 cursor-pointer ml-2">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => setIncludeExpired(e.target.checked)}
            className="rounded border-white/10 bg-slate-900 text-cyan-500 focus:ring-cyan-500/50"
          />
          <span className="text-xs font-semibold text-slate-400">Include Expired</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 transition"
        >
          🔄 Refresh
        </button>

        <button
          type="button"
          onClick={onGenerate}
          className="px-4 py-2 rounded-xl text-xs font-bold text-static-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-md shadow-cyan-500/20 flex items-center gap-1.5"
        >
          <span>⚡ Generate Proposals</span>
        </button>
      </div>
    </GlassPanel>
  );
}
