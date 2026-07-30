import { GlassPanel } from "../../../components/ui/glass-panel";
import type { TradeIdeaOption } from "./paper-trading-dashboard";

interface OpenTradeModalProps {
  show: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  tradeIdeas: TradeIdeaOption[];
  selectedIdeaId: string;
  onIdeaSelectionChange: (id: string) => void;
  openFillPrice: number;
  setOpenFillPrice: (val: number) => void;
  openQuantity: number;
  setOpenQuantity: (val: number) => void;
  openOrderType: "MARKET" | "PENDING";
  setOpenOrderType: (val: "MARKET" | "PENDING") => void;
  openNotes: string;
  setOpenNotes: (val: string) => void;
  openError: string | null;
}

export function OpenTradeModal({
  show,
  onClose,
  onSubmit,
  tradeIdeas,
  selectedIdeaId,
  onIdeaSelectionChange,
  openFillPrice,
  setOpenFillPrice,
  openQuantity,
  setOpenQuantity,
  openOrderType,
  setOpenOrderType,
  openNotes,
  setOpenNotes,
  openError
}: OpenTradeModalProps) {
  if (!show) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-lg p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Simulate Position Entry</h3>
        <p className="text-xs text-slate-400 mt-1">Select an AI trade idea from the quantitative strategy engine and execute a simulated order.</p>
        {openError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{openError}</p>}
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Select Strategy Proposal</label>
            {tradeIdeas.length === 0 ? (
              <div className="mt-1 p-3 rounded-xl bg-slate-900 border border-white/10 text-xs text-slate-400">
                No active proposals found in database. Go to Strategy &amp; Ideas tab to generate new proposals first!
              </div>
            ) : (
              <select
                value={selectedIdeaId}
                onChange={(e) => onIdeaSelectionChange(e.target.value)}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                {tradeIdeas.map((idea) => (
                  <option key={idea.id} value={idea.id}>
                    {idea.side} {idea.instrumentSymbol} @ ₹{idea.entryPrice} (Target: ₹{idea.targetPrice}, SL: ₹{idea.stopLoss})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase mb-2">Order Type</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="radio" checked={openOrderType === "MARKET"} onChange={() => setOpenOrderType("MARKET")} className="text-cyan-500 focus:ring-cyan-500" />
                Market (Fill Now)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="radio" checked={openOrderType === "PENDING"} onChange={() => setOpenOrderType("PENDING")} className="text-cyan-500 focus:ring-cyan-500" />
                Pending (Wait for Price)
              </label>
            </div>
            {openOrderType === "PENDING" && (
              <p className="text-[10px] text-emerald-400 mt-1 pl-6">Trade will stay pending until market price hits the entry level.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Fill Price (₹)</label>
              <input
                type="number"
                required
                step="0.05"
                min="0.05"
                value={openFillPrice}
                onChange={(e) => setOpenFillPrice(Number(e.target.value))}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Quantity (Shares/Lots)</label>
              <input
                type="number"
                required
                min="1"
                step="1"
                value={openQuantity}
                onChange={(e) => setOpenQuantity(Number(e.target.value))}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Order Notes</label>
            <input
              type="text"
              value={openNotes}
              onChange={(e) => setOpenNotes(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              placeholder="e.g. Entering on breakout confirmation"
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
              disabled={!selectedIdeaId}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50"
            >
              Confirm Simulation
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
