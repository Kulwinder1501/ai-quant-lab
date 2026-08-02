import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";
import type { PaperTradeRow } from "../domain";

interface CloseTradeModalProps {
  show: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  tradeToClose: PaperTradeRow | null;
  closeExitPrice: number;
  setCloseExitPrice: (val: number) => void;
  closeNotes: string;
  setCloseNotes: (val: string) => void;
  closeError: string | null;
}

export function CloseTradeModal({
  show,
  onClose,
  onSubmit,
  tradeToClose,
  closeExitPrice,
  setCloseExitPrice,
  closeNotes,
  setCloseNotes,
  closeError
}: CloseTradeModalProps) {
  if (!show || !tradeToClose) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md p-6 border-rose-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Manual Position Exit</h3>
        <p className="text-xs text-slate-400 mt-1">
          Closing simulated {tradeToClose.side} position on {tradeToClose.instrumentSymbol} ({tradeToClose.quantity} units entered at ₹{formatNumber(tradeToClose.fillPrice, 2)}).
        </p>
        {closeError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{closeError}</p>}
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Exit Price (₹)</label>
            <input
              type="number"
              required
              step="0.05"
              min="0.05"
              value={closeExitPrice}
              onChange={(e) => setCloseExitPrice(Number(e.target.value))}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-400"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Exit Notes</label>
            <input
              type="text"
              value={closeNotes}
              onChange={(e) => setCloseNotes(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-400"
              placeholder="e.g. Taking profits ahead of news event"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-sm font-semibold text-static-white bg-rose-600 hover:bg-rose-500 transition shadow-lg shadow-rose-500/20"
            >
              Close Position
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
