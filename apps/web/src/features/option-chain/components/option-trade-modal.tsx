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

function floorToTick(value: number): number {
  return Math.floor(value / PREMIUM_TICK + 1e-9) * PREMIUM_TICK;
}

/** A premium as the text a field holds: two decimals, no float noise. */
function premiumText(value: number): string {
  return roundToTick(value).toFixed(2);
}

/** Quick picks, as a fraction of the entry price. The default is the middle of each row. */
const STOP_PRESETS = [0.2, 0.3, 0.5] as const;
const TARGET_PRESETS = [0.3, 0.6, 1.0] as const;

/** A limit starts this far under the ask: close enough to fill, far enough to be a real limit. */
const DEFAULT_LIMIT_DISCOUNT = 0.01;

const VALIDITY_OPTIONS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "EOD", label: "Till market close" },
] as const;

/**
 * A stop or target is either a preset fraction of the entry price, which follows the price while it moves, or
 * text the user typed, which stays put. Holding it this way means the field never has to be rewritten by an effect.
 */
type Level = { kind: "pct"; fraction: number } | { kind: "text"; text: string };

type OrderType = "MARKET" | "LIMIT";

export interface OptionTradeModalProps {
  show: boolean;
  onClose: () => void;
  underlyingSymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiryDate: string;
  /** The ask when the ticket was opened. Used until a live one arrives. */
  premium: number;
  impliedVolatility: number | null;
  /** The contract's current quote, kept up to date by the caller while the ticket is open. */
  livePremium?: { bid: number | null; ask: number | null } | null;
  /** The account to preselect, so a ticket opened from a page that already has one does not default to the first. */
  defaultAccountId?: string;
  /** Called once the order is placed, before `onClose`, so the caller can refresh what it shows. */
  onOpened?: () => void;
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
  livePremium,
  defaultAccountId,
  onOpened,
}: OptionTradeModalProps) {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(defaultAccountId ?? "");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [lots, setLots] = useState(1);
  const [limitText, setLimitText] = useState(() => premiumText(floorToTick(premium * (1 - DEFAULT_LIMIT_DISCOUNT))));
  const [validFor, setValidFor] = useState<string>("60");
  const [stop, setStop] = useState<Level>({ kind: "pct", fraction: STOP_PRESETS[1] });
  const [target, setTarget] = useState<Level>({ kind: "pct", fraction: TARGET_PRESETS[1] });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lotSize, setLotSize] = useState(75);
  const [feeTotal, setFeeTotal] = useState<number | null>(null);

  const liveAsk = livePremium?.ask != null && livePremium.ask > 0 ? livePremium.ask : premium;
  const liveBid = livePremium?.bid != null && livePremium.bid > 0 ? livePremium.bid : null;
  const isLimit = orderType === "LIMIT";

  const limitPrice = Number(limitText);
  const limitValid = Number.isFinite(limitPrice) && limitPrice > 0;
  // What the exits are measured from: the limit for a limit order (it fills at that price or better), else the ask.
  const entryRef = isLimit && limitValid ? limitPrice : liveAsk;

  const stopText = stop.kind === "pct" ? premiumText(entryRef * (1 - stop.fraction)) : stop.text;
  const targetText = target.kind === "pct" ? premiumText(entryRef * (1 + target.fraction)) : target.text;
  const stopLoss = Number(stopText);
  const targetPrice = Number(targetText);

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

  // Fees are priced at the entry reference, and re-read only when the whole-rupee figure or the lots change.
  const feeBasis = Math.round(entryRef);
  useEffect(() => {
    if (!show || !underlyingSymbol) return;
    const controller = new AbortController();
    const p = feeBasis > 0 ? feeBasis : 100;
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
  }, [show, underlyingSymbol, lots, feeBasis]);

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

  const quantity = lots * lotSize;
  const entryFees = feeTotal ?? 0;

  const limitError = useMemo(() => {
    if (!isLimit) return null;
    if (!limitValid) return "Enter a limit price above zero.";
    if (limitPrice >= liveAsk) return `The limit must be below the current ask (₹${liveAsk.toFixed(2)}). To buy at the current price, use Market.`;
    return null;
  }, [isLimit, limitValid, limitPrice, liveAsk]);

  const levelsError = useMemo(() => {
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) return "Enter a stop loss above zero.";
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return "Enter a target above zero.";
    if (stopLoss >= entryRef) return "The stop loss must be below the entry price.";
    if (targetPrice <= entryRef) return "The target must be above the entry price.";
    return null;
  }, [stopLoss, targetPrice, entryRef]);

  const problem = limitError ?? levelsError;
  const cost = entryRef * quantity + entryFees;
  const lossAtStop = problem === null ? (entryRef - stopLoss) * quantity + entryFees : null;
  const gainAtTarget = problem === null ? (targetPrice - entryRef) * quantity - entryFees : null;
  const rewardToRisk = lossAtStop !== null && gainAtTarget !== null && lossAtStop > 0 ? gainAtTarget / lossAtStop : null;

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
    if (problem !== null) {
      setError(problem);
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
        // Display context only: the server prices the fill from its own live quote.
        fillPrice: liveAsk,
        lots,
        impliedVolatility,
        stopLoss,
        targetPrice,
        orderType,
        ...(isLimit
          ? { limitPrice, validForMinutes: validFor === "EOD" ? "EOD" : Number(validFor) }
          : {}),
        notes: isLimit
          ? `Manual ${optionType} limit order ${strike} at ${limitPrice}`
          : `Manual ${optionType} buy at ${strike}`,
      });
      setIsSubmitting(false);
      onOpened?.();
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to place the order."));
      setIsSubmitting(false);
    }
  };

  if (!show) return null;

  const fieldClass = "mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400";
  const tabClass = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${active ? "bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-400/40" : "text-slate-400 hover:text-slate-200"}`;

  const modalContent = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md max-h-screen overflow-y-auto p-4 sm:p-6 border-cyan-500/30 bg-slate-950 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {underlyingSymbol} · {expiryDate} · {strike} {optionType === "CE" ? "Call" : "Put"}
            </p>
            <p className="mt-1 text-2xl font-extrabold text-white">
              ₹{liveAsk.toFixed(2)}
              <span className="ml-2 text-xs font-normal text-slate-400">
                ask{liveBid !== null ? ` · bid ₹${liveBid.toFixed(2)}` : ""}
              </span>
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={isSubmitting} className="text-xl font-bold leading-none text-slate-400 hover:text-white" aria-label="Close">×</button>
        </div>

        {error && <p className="mt-3 text-xs text-rose-300 bg-rose-500/10 p-2 rounded border border-rose-500/20">{error}</p>}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="flex gap-1 rounded-xl bg-slate-900 p-1" role="tablist" aria-label="Order type">
            <button type="button" role="tab" aria-selected={!isLimit} onClick={() => setOrderType("MARKET")} className={tabClass(!isLimit)}>Market</button>
            <button type="button" role="tab" aria-selected={isLimit} onClick={() => setOrderType("LIMIT")} className={tabClass(isLimit)}>Limit</button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase">Lots <span className="font-normal normal-case text-slate-500">(Qty {quantity})</span></label>
              <div className="mt-1 flex items-center gap-2">
                <button type="button" onClick={() => setLots(Math.max(1, lots - 1))} className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white">−</button>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={lots}
                  onChange={(e) => setLots(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                  className="w-full rounded-xl bg-slate-900 border border-white/10 px-2 py-2 text-sm text-white text-center font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400"
                />
                <button type="button" onClick={() => setLots(lots + 1)} className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-white">+</button>
              </div>
            </div>

            {isLimit ? (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase">Limit price (₹)</label>
                <input
                  type="number"
                  required
                  step={PREMIUM_TICK}
                  min={PREMIUM_TICK}
                  value={limitText}
                  onChange={(e) => setLimitText(e.target.value)}
                  className={`${fieldClass} font-mono`}
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase">Price</label>
                <div className="mt-1 w-full rounded-xl border border-white/5 bg-slate-900/50 px-3.5 py-2 text-sm text-slate-300">At market</div>
              </div>
            )}
          </div>

          {isLimit && (
            <div>
              <p className="text-[11px] text-slate-400">
                Buys only if the ask falls to your limit. If it never does, the order lapses and nothing is bought.
              </p>
              <label className="mt-2 block text-xs font-semibold text-slate-300 uppercase">Valid for</label>
              <select value={validFor} onChange={(e) => setValidFor(e.target.value)} className={fieldClass}>
                {VALIDITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <p className="mt-1 text-[10px] text-slate-500">Whatever you choose, an unfilled order is cancelled at the 3:30 pm close.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-rose-300 uppercase">Stop loss (₹)</label>
              <input
                type="number"
                required
                step={PREMIUM_TICK}
                min={PREMIUM_TICK}
                value={stopText}
                onChange={(e) => setStop({ kind: "text", text: e.target.value })}
                className={`${fieldClass} font-mono focus:ring-rose-400`}
              />
              <div className="mt-1.5 flex gap-1">
                {STOP_PRESETS.map((fraction) => (
                  <button
                    key={fraction}
                    type="button"
                    onClick={() => setStop({ kind: "pct", fraction })}
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
                onChange={(e) => setTarget({ kind: "text", text: e.target.value })}
                className={`${fieldClass} font-mono focus:ring-emerald-400`}
              />
              <div className="mt-1.5 flex gap-1">
                {TARGET_PRESETS.map((fraction) => (
                  <button
                    key={fraction}
                    type="button"
                    onClick={() => setTarget({ kind: "pct", fraction })}
                    className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200 hover:bg-emerald-500/30"
                  >
                    +{Math.round(fraction * 100)}%
                  </button>
                ))}
              </div>
            </div>
          </div>

          {problem && <p className="text-[11px] text-rose-300">{problem}</p>}

          <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3 space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between font-bold text-white">
              <span>{isLimit ? "Cost if filled" : "Cost"}</span>
              <span className="text-cyan-300">₹{formatNumber(cost, 2)}</span>
            </div>
            <div className="flex justify-between"><span>Loss at stop</span><span className="text-rose-300">{lossAtStop === null ? "—" : `₹${formatNumber(lossAtStop, 2)}`}</span></div>
            <div className="flex justify-between"><span>Gain at target</span><span className="text-emerald-300">{gainAtTarget === null ? "—" : `₹${formatNumber(gainAtTarget, 2)}`}</span></div>
            <div className="flex justify-between border-t border-white/10 pt-1.5"><span>Reward : Risk</span><span className="font-bold text-white">{rewardToRisk === null ? "—" : rewardToRisk.toFixed(2)}</span></div>
            <p className="pt-1 text-[10px] text-slate-500">
              Includes ₹{formatNumber(entryFees, 2)} entry fees. Stop and target are checked against the live premium while the market is open. A position is
              not squared off at 15:15, so close it yourself if neither level is hit.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Account</label>
            <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className={fieldClass}>
              <option value="" disabled>Select an account...</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>{acc.name} (Fund: ₹{formatNumber(acc.openingBalance, 2)})</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !selectedAccountId || problem !== null}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-static-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {isSubmitting ? "Placing..." : isLimit ? "Place limit order" : "Buy at market"}
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : null;
}
