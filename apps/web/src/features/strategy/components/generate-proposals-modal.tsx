import React from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface GenerateProposalsModalProps {
  show: boolean;
  onClose: () => void;
  genSymbol: string;
  setGenSymbol: (v: string) => void;
  genTimeframe: string;
  setGenTimeframe: (v: string) => void;
  isScalp: boolean;
  generating: boolean;
  genMessage: string | null;
  genError: string | null;
  onSubmit: (e: React.FormEvent) => void;
}

export function GenerateProposalsModal({
  show,
  onClose,
  genSymbol,
  setGenSymbol,
  genTimeframe,
  setGenTimeframe,
  isScalp,
  generating,
  genMessage,
  genError,
  onSubmit,
}: GenerateProposalsModalProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md max-h-[90vh] overflow-y-auto p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Generate Breakout Proposals</h3>
        <p className="text-xs text-slate-400 mt-1">
          Evaluate the latest completed market candles against the Trend Breakout strategy rules.
        </p>

        {genMessage && <p className="mt-3 text-xs text-cyan-300 bg-cyan-500/10 p-2.5 rounded-xl border border-cyan-500/20 font-medium">{genMessage}</p>}
        {genError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{genError}</p>}

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Instrument Symbol</label>
            <select
              value={genSymbol}
              onChange={(e) => setGenSymbol(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 font-bold"
            >
              <option value="NIFTY50">⚡ NIFTY 50 (NIFTY50)</option>
              <option value="BANKNIFTY">⚡ NIFTY BANK (BANKNIFTY)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Timeframe</label>
            <select
              value={genTimeframe}
              onChange={(e) => setGenTimeframe(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            >
              {isScalp ? (
                <option value="1m">1 Minute (1m) - Momentum Scalp</option>
              ) : (
                <>
                  <option value="15m">15 Minutes (15m)</option>
                  <option value="1h">1 Hour (1h)</option>
                  <option value="1d">Daily (1d)</option>
                  <option value="1w">Weekly (1w)</option>
                </>
              )}
            </select>
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
              disabled={generating}
              className="px-5 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
            >
              {generating ? (
                <>
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Evaluating...</span>
                </>
              ) : (
                <span>⚡ Run Evaluation</span>
              )}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
