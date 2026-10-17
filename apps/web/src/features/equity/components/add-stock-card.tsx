"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Sparkles } from "lucide-react";
import type { EquityExchange, WatchlistStockItem } from "../types";
import { addStockToWatchlist, EquityApiError } from "../api";

interface AddStockCardProps {
  onStockAdded: (stock: WatchlistStockItem) => void;
  disabled?: boolean;
  lastRefreshedAt?: Date | null;
}

export function AddStockCard({ onStockAdded, disabled = false, lastRefreshedAt }: AddStockCardProps) {
  const [symbol, setSymbol] = useState("");
  const [exchange, setExchange] = useState<EquityExchange>("NSE");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<string | null>(null);

  // Defect 6: Reset error banner when page is refreshed (official React prop-change pattern)
  const [prevRefreshedAt, setPrevRefreshedAt] = useState<Date | null>(null);
  if (lastRefreshedAt && lastRefreshedAt !== prevRefreshedAt) {
    setPrevRefreshedAt(lastRefreshedAt);
    if (errorMessage) setErrorMessage(null);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessInfo(null);

    const cleanSymbol = symbol.trim().toUpperCase();

    // Client-side validation (Gate S1)
    if (!cleanSymbol) {
      setErrorMessage("Please enter an equity symbol.");
      return;
    }

    if (!/^[A-Z0-9&-]{1,20}$/.test(cleanSymbol)) {
      setErrorMessage("Invalid symbol format. Symbols must be 1-20 uppercase letters, numbers, hyphens or ampersands.");
      return;
    }

    try {
      setIsSubmitting(true);
      const added = await addStockToWatchlist({
        symbol: cleanSymbol,
        exchange,
        note: note.trim() || undefined,
      });

      const totalBars = added.historyDepth?.totalBars ?? 0;
      setSuccessInfo(
        `Added ${added.symbol} (${added.displayName ?? added.symbol}) - initial backfill complete (${totalBars} daily bars stored).`,
      );
      setSymbol("");
      setNote("");
      onStockAdded(added);
    } catch (err: unknown) {
      if (err instanceof EquityApiError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage("An unexpected error occurred while adding the stock.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 sm:p-5 backdrop-blur-md shadow-lg shadow-black/20">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Add Equity to Watchlist</h2>
        </div>
        <span className="text-xs text-slate-400">Validated against live Yahoo feed</span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          {/* Symbol Input */}
          <div className="sm:col-span-4">
            <label htmlFor="equity-symbol" className="block text-xs font-medium text-slate-300 mb-1">
              Symbol <span className="text-rose-400">*</span>
            </label>
            <input
              id="equity-symbol"
              type="text"
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value.toUpperCase());
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder="e.g. SUZLON, RELIANCE, TCS"
              maxLength={20}
              disabled={isSubmitting || disabled}
              className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white placeholder-slate-500 font-mono uppercase focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>

          {/* Exchange Selector */}
          <div className="sm:col-span-3">
            <span id="exchange-label" className="block text-xs font-medium text-slate-300 mb-1">
              Exchange
            </span>
            <div
              role="radiogroup"
              aria-labelledby="exchange-label"
              className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-slate-950/70 p-1"
            >
              <button
                type="button"
                role="radio"
                aria-checked={exchange === "NSE"}
                onClick={() => setExchange("NSE")}
                disabled={isSubmitting || disabled}
                className={`rounded-md py-1 text-xs font-semibold transition ${
                  exchange === "NSE"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                NSE (.NS)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={exchange === "BSE"}
                onClick={() => setExchange("BSE")}
                disabled={isSubmitting || disabled}
                className={`rounded-md py-1 text-xs font-semibold transition ${
                  exchange === "BSE"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                BSE (.BO)
              </button>
            </div>
          </div>

          {/* Optional Note */}
          <div className="sm:col-span-3">
            <label htmlFor="equity-note" className="block text-xs font-medium text-slate-300 mb-1">
              Note <span className="text-slate-500">(Optional)</span>
            </label>
            <input
              id="equity-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Core watchlist"
              maxLength={100}
              disabled={isSubmitting || disabled}
              className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>

          {/* Submit Button */}
          <div className="sm:col-span-2 flex items-end">
            <button
              type="submit"
              disabled={isSubmitting || disabled || !symbol.trim()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-cyan-500/20 transition hover:from-cyan-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>Backfilling...</span>
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  <span>Add Stock</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Inline Feedback States (Gate S11) */}
        {errorMessage && (
          <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 animate-fadeIn">
            <AlertCircle className="size-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <span className="font-semibold">Unable to add stock: </span>
              <span>{errorMessage}</span>
            </div>
          </div>
        )}

        {successInfo && (
          <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 animate-fadeIn">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-400 mt-0.5" />
            <div>
              <span className="font-semibold">Success: </span>
              <span>{successInfo}</span>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
