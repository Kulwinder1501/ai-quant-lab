import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";
import { getResearchJson, postResearchJson } from "../../research/api";

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

interface PaperAccountSummary {
  id: string;
  name: string;
  availableCapital: number;
}

export interface OptionTradeModalProps {
  show: boolean;
  onClose: () => void;
  underlyingSymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiryDate: string;
  premium: number;
  impliedVolatility: number | null;
  greeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
  };
}

export function OptionTradeModal({
  show,
  onClose,
  underlyingSymbol,
  strike,
  optionType,
  expiryDate,
  premium,
  impliedVolatility,
  greeks,
}: OptionTradeModalProps) {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [lots, setLots] = useState(1);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lotSize, setLotSize] = useState(75);
  const [feeTotal, setFeeTotal] = useState<number | null>(null);
  const [feeLines, setFeeLines] = useState<LotInfoResponse["data"]["feeEstimate"]["entry"] | null>(null);

  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    void getResearchJson("/paper-accounts", controller.signal)
      .then((res: any) => {
        const accs = res.data || [];
        setAccounts(accs);
        if (accs.length > 0 && !selectedAccountId) {
          setSelectedAccountId(accs[0].id);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [show]);

  useEffect(() => {
    if (!show || !underlyingSymbol) return;
    const controller = new AbortController();
    const p = premium > 0 ? premium : 100;
    void getResearchJson(
      `/instruments/by-symbol/${encodeURIComponent(underlyingSymbol)}/lot-info?lots=${lots}&premium=${p}`,
      controller.signal,
    )
      .then((res: any) => {
        const body = res as LotInfoResponse;
        setLotSize(body.data.lotSize);
        setFeeTotal(body.data.feeEstimate.entry.total);
        setFeeLines(body.data.feeEstimate.entry);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [show, underlyingSymbol, lots, premium]);

  useEffect(() => {
    if (show) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [show]);

  const quantity = useMemo(() => lots * lotSize, [lots, lotSize]);
  const notional = useMemo(() => premium * quantity, [premium, quantity]);
  const totalCost = useMemo(() => notional + (feeTotal ?? 0), [notional, feeTotal]);
  
  const breakeven = useMemo(() => {
    return optionType === "CE" ? strike + premium : strike - premium;
  }, [strike, premium, optionType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId) {
      setError("Please select a paper trading account.");
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      await postResearchJson("/paper-trades/open-manual-option", {
        accountId: selectedAccountId,
        underlyingSymbol,
        optionType,
        strike,
        expiryDate,
        fillPrice: premium,
        lots,
        impliedVolatility: impliedVolatility ?? 0.15,
        notes: notes || `Manual ${optionType} buy at ${strike}`,
      });
      setIsSubmitting(false);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to open trade.");
      setIsSubmitting(false);
    }
  };

  if (!show) return null;

  const modalContent = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-lg max-h-screen overflow-y-auto p-4 sm:p-6 border-cyan-500/30 bg-slate-950 shadow-2xl flex flex-col">
        <div className="flex-shrink-0">
          <h3 className="text-xl font-bold text-white">Buy Option Contract</h3>
          <p className="text-xs text-slate-400 mt-1">
            {underlyingSymbol} · {expiryDate} · {strike} {optionType}
          </p>
          {error && <p className="mt-2 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{error}</p>}
        </div>
        
        <form onSubmit={handleSubmit} className="mt-3 space-y-3 flex-1 overflow-y-auto pr-1">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Select Account</label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            >
              <option value="" disabled>Select an account...</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} (Available: ₹{formatNumber(acc.availableCapital, 2)})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Entry Premium (₹)</label>
              <div className="mt-1 w-full rounded-xl bg-slate-900/50 border border-white/5 px-3.5 py-2 text-sm text-slate-300 font-mono">
                {premium.toFixed(2)}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Number of Lots</label>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLots(Math.max(1, lots - 1))}
                  className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white"
                >
                  −
                </button>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={lots}
                  onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400"
                />
                <button
                  type="button"
                  onClick={() => setLots(lots + 1)}
                  className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white"
                >
                  +
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-400">
                {lots} × {lotSize} = {quantity} units
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5">
              <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Risk Profile</p>
              <ul className="text-xs text-slate-300 space-y-1">
                <li className="flex justify-between"><span>Max Risk</span><span className="text-rose-300">₹{formatNumber(notional, 2)}</span></li>
                <li className="flex justify-between"><span>Max Reward</span><span className="text-emerald-300">Infinite</span></li>
                <li className="flex justify-between border-t border-white/10 pt-1"><span>Breakeven</span><span className="font-bold text-white">₹{formatNumber(breakeven, 2)}</span></li>
              </ul>
            </div>
            
            <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5">
              <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Greeks</p>
              <ul className="text-[11px] text-slate-300 space-y-1 font-mono">
                <li className="flex justify-between"><span>Delta</span><span className={greeks.delta && greeks.delta > 0 ? "text-emerald-300" : (greeks.delta && greeks.delta < 0 ? "text-rose-300" : "text-slate-400")}>{greeks.delta?.toFixed(4) ?? "—"}</span></li>
                <li className="flex justify-between"><span>Gamma</span><span className="text-slate-400">{greeks.gamma?.toFixed(4) ?? "—"}</span></li>
                <li className="flex justify-between"><span>Theta</span><span className="text-amber-300">{greeks.theta?.toFixed(2) ?? "—"}</span></li>
                <li className="flex justify-between border-t border-white/10 pt-1"><span>Vega</span><span className="text-sky-300">{greeks.vega?.toFixed(2) ?? "—"}</span></li>
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Margin &amp; Cost Estimate</p>
            <div className="flex justify-between text-sm font-bold text-white">
              <span>Total Margin Required</span>
              <span className="text-cyan-300">₹{formatNumber(totalCost, 2)}</span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              Includes Premium (₹{formatNumber(notional, 2)}) + Entry Fees (₹{feeTotal ? formatNumber(feeTotal, 2) : "..."})
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Trade Notes (Optional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              placeholder="e.g. Bought ATM call on breakout"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !selectedAccountId}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-static-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {isSubmitting ? "Executing..." : "Execute Trade"}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : null;
}
