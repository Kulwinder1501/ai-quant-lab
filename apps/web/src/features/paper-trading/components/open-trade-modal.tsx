import { useEffect, useMemo, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";
import { getResearchJson } from "../../research/api";
import type { TradeIdeaOption } from "./paper-trading-dashboard";

interface LotInfoResponse {
  data: {
    lotSize: number;
    quantity: number;
    lots: number;
    feeEstimate: {
      entry: {
        brokerage: number;
        stt: number;
        exchangeCharges: number;
        sebiCharges: number;
        gst: number;
        stampDuty: number;
        total: number;
      };
      totalCost: number;
    };
  };
}

interface OpenTradeModalProps {
  show: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  tradeIdeas: TradeIdeaOption[];
  selectedIdeaId: string;
  onIdeaSelectionChange: (id: string) => void;
  openFillPrice: number;
  setOpenFillPrice: (val: number) => void;
  openLots: number;
  setOpenLots: (val: number) => void;
  openOrderType: "MARKET" | "PENDING";
  setOpenOrderType: (val: "MARKET" | "PENDING") => void;
  openNotes: string;
  setOpenNotes: (val: string) => void;
  openExpiryDate: string;
  setOpenExpiryDate: (val: string) => void;
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
  openLots,
  setOpenLots,
  openOrderType,
  setOpenOrderType,
  openNotes,
  setOpenNotes,
  openExpiryDate,
  setOpenExpiryDate,
  openError
}: OpenTradeModalProps) {
  const selected = tradeIdeas.find((idea) => idea.id === selectedIdeaId);
  const [lotSize, setLotSize] = useState(75);
  const [feeTotal, setFeeTotal] = useState<number | null>(null);
  const [feeLines, setFeeLines] = useState<LotInfoResponse["data"]["feeEstimate"]["entry"] | null>(null);

  useEffect(() => {
    if (!show || !selected?.instrumentSymbol) return;
    const controller = new AbortController();
    const premium = openFillPrice > 0 ? openFillPrice : 100;
    void getResearchJson(
      `/instruments/by-symbol/${encodeURIComponent(selected.instrumentSymbol)}/lot-info?lots=${openLots}&premium=${premium}`,
      controller.signal,
    )
      .then((res) => {
        const body = res as LotInfoResponse;
        setLotSize(body.data.lotSize);
        setFeeTotal(body.data.feeEstimate.entry.total);
        setFeeLines(body.data.feeEstimate.entry);
      })
      .catch(() => {
        /* keep last known lot size */
      });
    return () => controller.abort();
  }, [show, selected?.instrumentSymbol, openLots, openFillPrice]);

  const quantity = useMemo(() => openLots * lotSize, [openLots, lotSize]);
  const notional = useMemo(() => openFillPrice * quantity, [openFillPrice, quantity]);
  const totalCost = useMemo(
    () => notional + (feeTotal ?? 0),
    [notional, feeTotal],
  );

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Simulate Position Entry</h3>
        <p className="text-xs text-slate-400 mt-1">
          Option-buyer simulation with NSE lot sizes and Zerodha-style fees. Premium fill is priced via Black–Scholes on open.
        </p>
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
            <label className="block text-xs font-semibold text-slate-300 uppercase">Option Expiry</label>
            <input
              type="date"
              required
              value={openExpiryDate}
              onChange={(e) => setOpenExpiryDate(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Names the contract being priced. Not inferred — expiry weekdays differ by
              index and not every index has a weekly series.
            </p>
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
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Reference Underlying (₹)</label>
              <input
                type="number"
                required
                step="0.05"
                min="0.05"
                value={openFillPrice}
                onChange={(e) => setOpenFillPrice(Number(e.target.value))}
                className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
              <p className="mt-1 text-[10px] text-slate-500">Used to seed ATM option pricing on submit.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Number of Lots</label>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpenLots(Math.max(1, openLots - 1))}
                  className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white"
                >
                  −
                </button>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={openLots}
                  onChange={(e) => setOpenLots(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400"
                />
                <button
                  type="button"
                  onClick={() => setOpenLots(openLots + 1)}
                  className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white"
                >
                  +
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-400">
                {openLots} × {lotSize} = {quantity} units
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Fee Estimate (entry)</p>
            {feeLines ? (
              <ul className="text-xs text-slate-300 space-y-1">
                <li className="flex justify-between"><span>Brokerage</span><span>₹{formatNumber(feeLines.brokerage, 2)}</span></li>
                <li className="flex justify-between"><span>Stamp duty</span><span>₹{formatNumber(feeLines.stampDuty, 2)}</span></li>
                <li className="flex justify-between"><span>Exchange + SEBI + GST</span><span>₹{formatNumber(feeLines.exchangeCharges + feeLines.sebiCharges + feeLines.gst, 2)}</span></li>
                <li className="flex justify-between font-bold text-white border-t border-white/10 pt-1"><span>Entry fees</span><span>₹{formatNumber(feeLines.total, 2)}</span></li>
                <li className="flex justify-between font-bold text-cyan-300"><span>Total cost</span><span>₹{formatNumber(totalCost, 2)}</span></li>
              </ul>
            ) : (
              <p className="text-xs text-slate-500">Loading fee estimate…</p>
            )}
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
              className="px-5 py-2 rounded-xl text-sm font-semibold text-static-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50"
            >
              Confirm Simulation
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
