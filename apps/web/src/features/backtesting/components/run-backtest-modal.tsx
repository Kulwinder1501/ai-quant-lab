import React from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface RunBacktestModalProps {
  show: boolean;
  onClose: () => void;
  runSymbol: string;
  setRunSymbol: (val: string) => void;
  runTimeframe: string;
  setRunTimeframe: (val: string) => void;
  startDate: string;
  setStartDate: (val: string) => void;
  endDate: string;
  setEndDate: (val: string) => void;
  running: boolean;
  runMessage: string | null;
  runError: string | null;
  onSubmit: (e: React.FormEvent) => void;
}

export function RunBacktestModal({
  show,
  onClose,
  runSymbol,
  setRunSymbol,
  runTimeframe,
  setRunTimeframe,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  running,
  runMessage,
  runError,
  onSubmit,
}: RunBacktestModalProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Replay Historical Data</h3>
        <p className="text-xs text-slate-400 mt-1">
          Execute tick/candle-level strategy replay over a specified historical date range.
        </p>

        {runMessage && <p className="mt-3 text-xs text-emerald-300 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 font-bold">{runMessage}</p>}
        {runError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{runError}</p>}

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Instrument Symbol</label>
            <input
              type="text"
              required
              value={runSymbol}
              onChange={(e) => setRunSymbol(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 font-bold uppercase"
              placeholder="e.g. NIFTY50, RELIANCE"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Timeframe</label>
            <select
              value={runTimeframe}
              onChange={(e) => setRunTimeframe(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            >
              <option value="15m">15 Minutes (15m)</option>
              <option value="1h">1 Hour (1h)</option>
              <option value="1d">Daily (1d)</option>
              <option value="1w">Weekly (1w)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Start Date</label>
              <input
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">End Date</label>
              <input
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={running}
              className="px-5 py-2 rounded-xl text-sm font-bold text-static-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
            >
              {running ? (
                <>
                  <span className="h-4 w-4 border-2 border-static-white border-t-transparent rounded-full animate-spin" />
                  <span>Replaying...</span>
                </>
              ) : (
                <span>⚡ Execute Replay</span>
              )}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
