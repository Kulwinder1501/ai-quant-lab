import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";
import { getResearchJson, postResearchJson } from "../../research/api";
import { errorMessage } from "../../../lib/errors";

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
  openingBalance: number;
}

interface PaperAccountsResponse {
  data?: PaperAccountSummary[];
}

/** Option premiums trade in 5-paise ticks. */
const PREMIUM_TICK = 0.05;

function roundToTick(value: number): number {
  return Math.round(value / PREMIUM_TICK) * PREMIUM_TICK;
}

/** A premium input as the text a field holds: two decimals, no float noise. */
function premiumText(value: number): string {
  return roundToTick(value).toFixed(2);
}

/** Quick picks, as a fraction of the entry premium. The default is the middle of each row. */
const STOP_PRESETS = [0.2, 0.3, 0.5] as const;
const TARGET_PRESETS = [0.3, 0.6, 1.0] as const;

export interface OptionTradeModalProps {
  show: boolean;
  onClose: () => void;
  underlyingSymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiryDate: string;
  premium: number;
  impliedVolatility: number | null;
  /** The account to preselect, so a ticket opened from a page that already has one does not default to the first. */
  defaultAccountId?: string;
  /** Called once the trade is booked, before `onClose`, so the caller can refresh what it shows. */
  onOpened?: () => void;
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
  defaultAccountId,
  onOpened,
  greeks,
}: OptionTradeModalProps) {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(defaultAccountId ?? "");
  const [lots, setLots] = useState(1);
  // Premium levels, held as text so a half-typed number is not rewritten under the cursor.
  const [stopText, setStopText] = useState(() => premiumText(premium * (1 - STOP_PRESETS[1])));
  const [targetText, setTargetText] = useState(() => premiumText(premium * (1 + TARGET_PRESETS[1])));
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lotSize, setLotSize] = useState(75);
  const [feeTotal, setFeeTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    void getResearchJson("/paper-accounts", controller.signal)
      .then((value) => {
        const res = value as PaperAccountsResponse;
        const accs = res.data ?? [];
        setAccounts(accs);
        setSelectedAccountId((current) => current || accs[0]?.id || "");
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
      .then((value) => {
        const body = value as LotInfoResponse;
        setLotSize(body.data.lotSize);
        setFeeTotal(body.data.feeEstimate.entry.total);
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
  
  const stopLoss = Number(stopText);
  const targetPrice = Number(targetText);
  const levelsError = useMemo(() => {
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) return "Enter a stop loss premium above zero.";
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return "Enter a target premium above zero.";
    if (stopLoss >= premium) return "The stop loss must be below the entry premium.";
    if (targetPrice <= premium) return "The target must be above the entry premium.";
    return null;
  }, [stopLoss, targetPrice, premium]);
  const entryFees = feeTotal ?? 0;
  const lossAtStop = levelsError === null ? (premium - stopLoss) * quantity + entryFees : null;
  const gainAtTarget = levelsError === null ? (targetPrice - premium) * quantity - entryFees : null;
  const rewardToRisk = lossAtStop !== null && gainAtTarget !== null && lossAtStop > 0 ? gainAtTarget / lossAtStop : null;

  const breakeven = useMemo(() => {
    return optionType === "CE" ? strike + premium : strike - premium;
  }, [strike, premium, optionType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId) {
      setError("Please select a paper trading account.");
      return;
    }
    if (impliedVolatility === null) {
      setError("This contract has no measured implied volatility and cannot be opened safely.");
      return;
    }
    if (levelsError !== null) {
      setError(levelsError);
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
        impliedVolatility,
        stopLoss,
        targetPrice,
        notes: notes || `Manual ${optionType} buy at ${strike}`,
      });
      setIsSubmitting(false);
      onOpened?.();
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to open trade."));
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
                  {acc.name} (Fund: ₹{formatNumber(acc.openingBalance, 2)})
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

          <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-3">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Exit levels (option premium)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-rose-300 uppercase">Stop Loss (₹)</label>
                <input
                  type="number"
                  required
                  step={PREMIUM_TICK}
                  min={PREMIUM_TICK}
                  value={stopText}
                  onChange={(e) => setStopText(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-rose-400"
                />
                <div className="mt-1.5 flex gap-1">
                  {STOP_PRESETS.map((fraction) => (
                    <button
                      key={fraction}
                      type="button"
                      onClick={() => setStopText(premiumText(premium * (1 - fraction)))}
                      className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/30"
                    >
                      −{Math.round(fraction * 100)}%
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-emerald-300 uppercase">Target (₹)</label>
                <input
                  type="number"
                  required
                  step={PREMIUM_TICK}
                  min={PREMIUM_TICK}
                  value={targetText}
                  onChange={(e) => setTargetText(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
                <div className="mt-1.5 flex gap-1">
                  {TARGET_PRESETS.map((fraction) => (
                    <button
                      key={fraction}
                      type="button"
                      onClick={() => setTargetText(premiumText(premium * (1 + fraction)))}
                      className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200 hover:bg-emerald-500/30"
                    >
                      +{Math.round(fraction * 100)}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {levelsError && <p className="text-[11px] text-rose-300">{levelsError}</p>}
            <p className="text-[10px] text-slate-500">
              Checked against the contract&apos;s live premium every minute while the market is open. A manual position is not
              squared off at 15:15: if neither level is hit it stays open until you close it.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5">
              <p className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Risk Profile</p>
              <ul className="text-xs text-slate-300 space-y-1">
                <li className="flex justify-between"><span>Loss at stop</span><span className="text-rose-300">{lossAtStop === null ? "—" : `₹${formatNumber(lossAtStop, 2)}`}</span></li>
                <li className="flex justify-between"><span>Gain at target</span><span className="text-emerald-300">{gainAtTarget === null ? "—" : `₹${formatNumber(gainAtTarget, 2)}`}</span></li>
                <li className="flex justify-between"><span>Reward : Risk</span><span className="font-bold text-white">{rewardToRisk === null ? "—" : rewardToRisk.toFixed(2)}</span></li>
                <li className="flex justify-between border-t border-white/10 pt-1"><span>Breakeven</span><span className="font-bold text-white">₹{formatNumber(breakeven, 2)}</span></li>
              </ul>
              <p className="text-[10px] text-slate-500">Before exit fees. Entry fees are included.</p>
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
              disabled={isSubmitting || !selectedAccountId || levelsError !== null}
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
