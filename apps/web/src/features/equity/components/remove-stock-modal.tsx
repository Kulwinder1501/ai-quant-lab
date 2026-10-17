"use client";

import { AlertTriangle, Database, Loader2, X } from "lucide-react";
import type { WatchlistStockItem } from "../types";

interface RemoveStockModalProps {
  stock: WatchlistStockItem | null;
  isOpen: boolean;
  isRemoving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RemoveStockModal({
  stock,
  isOpen,
  isRemoving,
  onClose,
  onConfirm,
}: RemoveStockModalProps) {
  if (!isOpen || !stock) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-slate-900 shadow-2xl p-6 text-slate-200 relative animate-scaleUp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-stock-title"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={isRemoving}
          className="absolute top-4 right-4 text-slate-400 hover:text-white transition disabled:opacity-50"
          aria-label="Close dialog"
        >
          <X className="size-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400 border border-rose-500/20">
            <AlertTriangle className="size-5" />
          </div>
          <div>
            <h3 id="remove-stock-title" className="text-base font-bold text-white">
              Remove from Watchlist
            </h3>
            <p className="text-xs text-slate-400">
              {stock.symbol} ({stock.exchange}) - {stock.displayName}
            </p>
          </div>
        </div>

        <div className="space-y-3 text-sm text-slate-300">
          <p>
            Are you sure you want to remove <span className="font-semibold text-white">{stock.symbol}</span> from your active watchlist?
          </p>

          <div className="flex items-start gap-2.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-cyan-200">
            <Database className="size-4 shrink-0 text-cyan-400 mt-0.5" />
            <div>
              <span className="font-semibold text-cyan-300">Historical History Preserved: </span>
              <span>
                All {stock.historyDepth.totalBars.toLocaleString()} historical daily bars and corporate actions will remain safely stored in the database.
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isRemoving}
            className="rounded-lg border border-white/10 bg-slate-800/80 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isRemoving}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-rose-600/30 hover:bg-rose-500 transition disabled:opacity-50"
          >
            {isRemoving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span>Removing...</span>
              </>
            ) : (
              <span>Confirm Removal</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
