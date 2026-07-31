import React, { useEffect, useState } from "react";
import { formatNumber } from "../../research/presentation";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getResearchJson } from "../../research/api";
import type { TradeIdeaRow } from "../domain";

interface PaperAccountOption {
  id: string;
  name: string;
  openingBalance: number;
}

interface SimulateTradeModalProps {
  show: boolean;
  onClose: () => void;
  selectedIdea: TradeIdeaRow | null;
  accounts: PaperAccountOption[];
  simAccountId: string;
  setSimAccountId: (v: string) => void;
  simLots: number;
  setSimLots: (v: number) => void;
  simNotes: string;
  setSimNotes: (v: string) => void;
  simExpiryDate: string;
  setSimExpiryDate: (v: string) => void;
  simulating: boolean;
  simSuccess: string | null;
  simError: string | null;
  onSubmit: (e: React.FormEvent) => void;
}

export function SimulateTradeModal({
  show,
  onClose,
  selectedIdea,
  accounts,
  simAccountId,
  setSimAccountId,
  simLots,
  setSimLots,
  simNotes,
  setSimNotes,
  simExpiryDate,
  setSimExpiryDate,
  simulating,
  simSuccess,
  simError,
  onSubmit,
}: SimulateTradeModalProps) {
  const [lotSize, setLotSize] = useState(75);
  const [entryFees, setEntryFees] = useState<number | null>(null);

  useEffect(() => {
    if (!show || !selectedIdea) return;
    const controller = new AbortController();
    void getResearchJson(
      `/instruments/by-symbol/${encodeURIComponent(selectedIdea.instrumentSymbol)}/lot-info?lots=${simLots}&premium=100`,
      controller.signal,
    )
      .then((res: any) => {
        setLotSize(res.data.lotSize);
        setEntryFees(res.data.feeEstimate.entry.total);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [show, selectedIdea, simLots]);

  if (!show || !selectedIdea) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md max-h-[90vh] overflow-y-auto p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Simulate in Paper Portfolio</h3>
        <p className="text-xs text-slate-400 mt-1">
          Buy ATM {selectedIdea.side === "SHORT" ? "PE" : "CE"} for {selectedIdea.instrumentSymbol} (option-buyer). Underlying ref ₹{formatNumber(selectedIdea.entryPrice, 2)}.
        </p>

        {simSuccess && <p className="mt-3 text-xs text-emerald-300 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 font-bold">{simSuccess}</p>}
        {simError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{simError}</p>}

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Target Paper Portfolio</label>
            {accounts.length === 0 ? (
              <div className="mt-1 p-3 rounded-xl bg-slate-900 border border-white/10 text-xs text-rose-300">
                No paper trading portfolios found. Please create one in the Paper Trading tab first!
              </div>
            ) : (
              <select
                value={simAccountId}
                onChange={(e) => setSimAccountId(e.target.value)}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} (Balance: ₹{formatNumber(acc.openingBalance, 0)})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Number of Lots</label>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" onClick={() => setSimLots(Math.max(1, simLots - 1))} className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white">−</button>
              <input
                type="number"
                required
                min="1"
                step="1"
                value={simLots}
                onChange={(e) => setSimLots(Math.max(1, Number(e.target.value) || 1))}
                className="w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
              <button type="button" onClick={() => setSimLots(simLots + 1)} className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white">+</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-400">{simLots} × {lotSize} = {simLots * lotSize} units</p>
            {entryFees !== null && (
              <p className="mt-1 text-[10px] text-cyan-300/80">Est. entry fees ≈ ₹{formatNumber(entryFees, 2)} (exact on fill premium)</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Option Expiry</label>
            <input
              type="date"
              required
              value={simExpiryDate}
              onChange={(e) => setSimExpiryDate(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Names the contract being priced. Not inferred � expiry weekdays differ by
              index and not every index has a weekly series.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Simulation Notes</label>
            <input
              type="text"
              value={simNotes}
              onChange={(e) => setSimNotes(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
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
              disabled={simulating || accounts.length === 0}
              className="px-5 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
            >
              {simulating ? (
                <>
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Simulating...</span>
                </>
              ) : (
                <span>Confirm Order</span>
              )}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
