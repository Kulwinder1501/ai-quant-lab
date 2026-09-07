"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "../../../hooks/use-sse";
import { getApiV1Url } from "../../research/api";

interface MarketWatchItem {
  symbol: string;
  price: string | number;
  changePercent: number;
  aiStance: "BULL" | "BEAR" | "NEUT";
}

/**
 * The tiles the dashboard can actually be switched to, as opposed to merely watched.
 *
 * `/stream/market-watch` quotes seven tiles, but the dashboard below the selector needs **stored
 * candles**: `/stream/live-agent` reads `listCandlesWithOverlays(symbol, …)` and returns early
 * when fewer than two bars come back, sending nothing at all. So a symbol with no series does not
 * degrade — it leaves the page on "Connecting to Live Stream…" indefinitely.
 *
 * Measured 2026-08-13 against the v2 database: NIFTY50 (113,930 bars) and BANKNIFTY (99,183) are
 * registered and active. SENSEX, HANG SENG, NIKKEI 225 and S&P 500 are **not registered as
 * instruments at all** and have no candles. FINNIFTY has 14,403 bars but is `is_active = FALSE`,
 * which this repository uses to mark an instrument research-only — the same flag
 * `assertScannableSymbols` refuses to trade through — so promoting it into a trading surface is a
 * deliberate decision and not one a dropdown should make silently.
 *
 * The other five therefore stay visible with their live prices, which is the point of a watch
 * list, but are not selectable. Showing them as ordinary options would offer a click that can
 * only ever produce a blank dashboard.
 */
const SELECTABLE_SYMBOLS = new Set(["NIFTY50", "BANKNIFTY"]);

function formatPrice(price: string | number): string {
  return typeof price === "number"
    ? price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : price;
}

export function MarketWatchSelect({
  selectedSymbol,
  onSelect,
}: {
  selectedSymbol?: string;
  onSelect?: (symbol: string) => void;
}) {
  // `useSSE` rather than a raw EventSource. The hand-rolled version set only `onmessage`, so a
  // dropped stream stayed dropped -- no `onerror`, no reconnect, and the panel silently froze on
  // its last tick with no indication the feed had gone. The hook already implements the
  // backoff-and-retry this needs.
  const streamUrl = useMemo(() => `${getApiV1Url()}/stream/market-watch`, []);
  const { data } = useSSE<MarketWatchItem[]>(streamUrl);
  const watchlist = useMemo(() => data ?? [], [data]);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Flash direction per symbol, from the previous payload.
   *
   * React's "storing information from previous renders" pattern -- compare against state held
   * from the last render and adjust it during this one -- rather than an effect or a ref. The
   * original compared prices inside an effect and wrote the result back with `setFlashing`,
   * which is a render triggered by a render, and cleared it with an uncleaned
   * `setTimeout(…, 800)` that fired after unmount and, when two ticks landed inside 800ms,
   * cleared the newer flash instead of the older one. The fade is now a one-shot CSS animation
   * that ends on its own, so nothing has to remember to clear it.
   */
  const [previous, setPrevious] = useState<{
    payload: MarketWatchItem[] | null;
    flashing: Record<string, "up" | "down">;
  }>({ payload: null, flashing: {} });

  if (previous.payload !== data) {
    const directions: Record<string, "up" | "down"> = {};
    const priorPrices = new Map((previous.payload ?? []).map((item) => [item.symbol, Number(item.price)]));
    for (const item of watchlist) {
      const priorPrice = priorPrices.get(item.symbol);
      const currentPrice = Number(item.price);
      if (priorPrice !== undefined && priorPrice !== currentPrice) {
        directions[item.symbol] = currentPrice > priorPrice ? "up" : "down";
      }
    }
    setPrevious({ payload: data, flashing: directions });
  }
  const flashing = previous.flashing;

  // Dismissal is on the document because the panel overlays the grid below it: a click meant for
  // the chart should close the list rather than land on whatever is underneath.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = useCallback((symbol: string) => {
    if (!SELECTABLE_SYMBOLS.has(symbol)) return;
    onSelect?.(symbol);
    setOpen(false);
  }, [onSelect]);

  const selected = watchlist.find((item) => item.symbol === selectedSymbol);
  const selectedIsPositive = (selected?.changePercent ?? 0) >= 0;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-md border border-cyan-500/50 bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition hover:border-cyan-400 focus:outline-none focus:border-cyan-400 shadow-lg cursor-pointer"
      >
        <span className="text-[10px]">⚡</span>
        <span>{selectedSymbol}</span>
        {selected && (
          <>
            <span className="font-mono text-slate-200">{formatPrice(selected.price)}</span>
            <span className={`font-mono text-[10px] ${selectedIsPositive ? "text-emerald-400" : "text-rose-400"}`}>
              {selectedIsPositive ? "▲" : "▼"} {Math.abs(selected.changePercent).toFixed(2)}%
            </span>
          </>
        )}
        <span className={`text-[8px] text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
      </button>

      {open && (
        /*
         * Anchored left below `xl` and right from `xl` up, because the header it sits in is
         * `justify-between` + `flex-wrap`: on a wide viewport the trigger is pinned to the right,
         * so a panel growing rightward would leave the screen, and once the header wraps the
         * trigger moves to the left, where a panel growing leftward is clipped instead. Measured
         * at a 730px viewport, right-anchoring put the panel at -13..307 and cut off its first
         * 13px, hiding the "Market Watch" heading and the start of every row.
         *
         * `max-w` is the backstop for widths where neither rule is a clean fit -- it keeps the
         * panel inside the viewport instead of letting it overhang by a few pixels.
         */
        <div
          role="listbox"
          className="absolute left-0 z-50 mt-2 w-[320px] max-w-[calc(100vw-1.5rem)] rounded-md border border-white/10 bg-slate-900/95 p-3 shadow-2xl backdrop-blur-md xl:left-auto xl:right-0"
        >
          <div className="mb-2 flex items-center justify-between border-b border-white/5 pb-2">
            <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
              Market Watch
            </h3>
          </div>

          <div className="max-h-[320px] overflow-y-auto custom-scrollbar pr-1">
            <table className="w-full text-left text-xs font-mono">
              <thead className="sticky top-0 z-10 bg-slate-900/95 text-[9px] uppercase tracking-wider text-slate-500 backdrop-blur-sm">
                <tr>
                  <th className="pb-2 font-semibold">Asset</th>
                  <th className="pb-2 text-right font-semibold">Price</th>
                  <th className="w-10 pb-2 text-center font-semibold">AI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.02]">
                {watchlist.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-[10px] italic text-slate-500">
                      Connecting to live feed...
                    </td>
                  </tr>
                )}
                {watchlist.map((item) => {
                  const isPos = item.changePercent >= 0;
                  const isSelected = item.symbol === selectedSymbol;
                  const isSelectable = SELECTABLE_SYMBOLS.has(item.symbol);
                  const flash = flashing[item.symbol];

                  const rowClass = isSelected
                    ? "bg-cyan-500/10"
                    : isSelectable
                      ? "hover:bg-white/[0.02] cursor-pointer"
                      : "cursor-not-allowed opacity-50";
                  const flashClass = flash === "up"
                    ? "animate-flash-up"
                    : flash === "down" ? "animate-flash-down" : "";

                  return (
                    <tr
                      // The price is part of the key so a changed price remounts the row and replays
                      // the one-shot flash animation. Without it React reuses the element, the
                      // animation is considered already-run, and only the first tick ever flashes.
                      key={`${item.symbol}:${flash ? item.price : "static"}`}
                      onClick={() => choose(item.symbol)}
                      aria-selected={isSelected}
                      aria-disabled={!isSelectable}
                      title={isSelectable
                        ? undefined
                        : `${item.symbol} is quoted for reference only — it has no stored candle series, so the dashboard cannot stream it.`}
                      className={`group transition-all duration-300 ${rowClass} ${flashClass}`}
                    >
                      <td className={`max-w-[110px] truncate py-2.5 font-bold ${isSelected ? "text-cyan-400" : "text-slate-300 group-hover:text-white"}`}>
                        {isSelected && <span className="mr-1 text-[10px]">⚡</span>}
                        {item.symbol}
                      </td>
                      <td className="py-2.5 text-right">
                        <div className={`transition-colors duration-300 ${flash === "up" ? "font-bold text-emerald-400" : flash === "down" ? "font-bold text-rose-400" : "text-slate-200"}`}>
                          {formatPrice(item.price)}
                        </div>
                        <div className={`text-[10px] ${isPos ? "text-emerald-400" : "text-rose-400"}`}>
                          {isPos ? "▲" : "▼"} {Math.abs(item.changePercent).toFixed(2)}%
                        </div>
                      </td>
                      <td className="py-2.5 text-right">
                        <span className={`inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[9px] font-black ${
                          item.aiStance === "BULL" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" :
                          item.aiStance === "BEAR" ? "border-rose-500/20 bg-rose-500/10 text-rose-400" :
                          "border-slate-500/20 bg-slate-500/10 text-slate-400"
                        }`}>
                          {item.aiStance}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-relaxed text-slate-500">
            Dimmed rows are quoted for reference only — no stored candle series to stream.
          </p>
        </div>
      )}
    </div>
  );
}
