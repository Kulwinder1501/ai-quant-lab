import React from "react";
import { formatNumber } from "../../research/presentation";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface CloseTradeModalProps {
  tradeToClose: any;
  setTradeToClose: (trade: any) => void;
  closeExitPrice: number;
  setCloseExitPrice: (price: number) => void;
  closeNotes: string;
  setCloseNotes: (notes: string) => void;
  closeError: string | null;
  closeLoading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function CloseTradeModal({
  tradeToClose,
  setTradeToClose,
  closeExitPrice,
  setCloseExitPrice,
  closeNotes,
  setCloseNotes,
  closeError,
  closeLoading,
  onSubmit
}: CloseTradeModalProps) {
  if (!tradeToClose) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
      <GlassPanel className="w-full max-w-md p-6 border-cyan-500/40 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <h3 className="text-base font-extrabold text-white flex items-center gap-2">
            <span>⚡ Manually Close AI Position</span>
          </h3>
          <button
            type="button"
            onClick={() => setTradeToClose(null)}
            className="text-slate-400 hover:text-white font-bold text-lg"
          >
            ×
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div className="p-3 rounded-xl bg-slate-950/80 border border-white/5 text-xs text-slate-300 space-y-1">
            <div>Instrument: <strong className="text-white">{tradeToClose.instrumentSymbol || "NIFTY50"}</strong></div>
            <div>Side &amp; Qty: <strong className="text-cyan-300">{tradeToClose.side} {tradeToClose.quantity} Qty</strong></div>
            <div>Entry Price: <strong className="text-white">₹{formatNumber(tradeToClose.fillPrice, 2)}</strong></div>
          </div>

          <div>
            <label htmlFor="exit-price" className="block text-xs font-bold text-slate-300 mb-1">
              Exit Price (₹):
            </label>
            <input
              id="exit-price"
              type="number"
              step="0.05"
              required
              value={closeExitPrice}
              onChange={(e) => setCloseExitPrice(Number(e.target.value))}
              className="w-full rounded-xl bg-slate-950 border border-white/20 px-3 py-2 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">Pre-filled with latest market valuation.</p>
          </div>

          <div>
            <label htmlFor="close-notes" className="block text-xs font-bold text-slate-300 mb-1">
              Exit Reason / Notes:
            </label>
            <input
              id="close-notes"
              type="text"
              value={closeNotes}
              onChange={(e) => setCloseNotes(e.target.value)}
              className="w-full rounded-xl bg-slate-950 border border-white/20 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
          </div>

          {closeError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs font-semibold">
              {closeError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-white/10">
            <button
              type="button"
              onClick={() => setTradeToClose(null)}
              className="px-4 py-2 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={closeLoading}
              className="px-5 py-2 rounded-xl text-xs font-extrabold text-white bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 transition shadow-lg shadow-rose-500/20 disabled:opacity-50 flex items-center gap-2"
            >
              {closeLoading ? "Closing..." : "⚡ Confirm Exit Position"}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
