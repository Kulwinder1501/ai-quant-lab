import { GlassPanel } from "../../../components/ui/glass-panel";

import { useMemo, useState } from "react";
import { useSSE } from "../../../hooks/use-sse";
import { getApiV1Url } from "../../research/api";

interface MarketWatchItem {
  symbol: string;
  price: string | number;
  changePercent: number;
  aiStance: "BULL" | "BEAR" | "NEUT";
}

export function MarketWatch({ selectedSymbol, onSelect }: { selectedSymbol?: string, onSelect?: (s: string) => void }) {
  // `useSSE` rather than a raw EventSource. The hand-rolled version set only `onmessage`, so a
  // dropped stream stayed dropped -- no `onerror`, no reconnect, and the panel silently froze on
  // its last tick with no indication the feed had gone. The hook already implements the
  // backoff-and-retry this needs and was, until now, imported by nothing.
  const streamUrl = useMemo(() => `${getApiV1Url()}/stream/market-watch`, []);
  const { data } = useSSE<MarketWatchItem[]>(streamUrl);
  const watchlist = useMemo(() => data ?? [], [data]);

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

  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 flex flex-col h-full rounded-md">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
          Market Watch
        </h3>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
        <table className="w-full text-left text-xs font-mono">
          <thead className="text-[9px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900/90 backdrop-blur-sm z-10">
            <tr>
              <th className="pb-2 font-semibold">Asset</th>
              <th className="pb-2 text-right font-semibold">Price</th>
              <th className="pb-2 text-center font-semibold w-10">AI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.02]">
            {watchlist.length === 0 && (
              <tr><td colSpan={3} className="text-center py-4 text-[10px] text-slate-500 italic">Connecting to live feed...</td></tr>
            )}
            {watchlist.map((item) => {
              const isPos = item.changePercent >= 0;
              const isSelected = item.symbol === selectedSymbol;
              const flash = flashing[item.symbol];

              const rowClass = isSelected ? 'bg-cyan-500/10' : 'hover:bg-white/[0.02]';
              const flashClass = flash === 'up'
                ? 'animate-flash-up'
                : flash === 'down' ? 'animate-flash-down' : '';

              return (
                <tr
                  // The price is part of the key so a changed price remounts the row and replays
                  // the one-shot flash animation. Without it React reuses the element, the
                  // animation is considered already-run, and only the first tick ever flashes.
                  key={`${item.symbol}:${flash ? item.price : 'static'}`}
                  onClick={() => onSelect?.(item.symbol)}
                  className={`group transition-all duration-300 cursor-pointer ${rowClass} ${flashClass}`}
                >
                  <td className={`py-2.5 font-bold truncate max-w-[80px] ${isSelected ? 'text-cyan-400' : 'text-slate-300 group-hover:text-white'}`}>
                    {isSelected && <span className="mr-1 text-[10px]">⚡</span>}
                    {item.symbol}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className={`transition-colors duration-300 ${flash === 'up' ? 'text-emerald-400 font-bold' : flash === 'down' ? 'text-rose-400 font-bold' : 'text-slate-200'}`}>
                      {typeof item.price === "number" ? item.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : item.price}
                    </div>
                    <div className={`text-[10px] ${isPos ? "text-emerald-400" : "text-rose-400"}`}>
                      {isPos ? "▲" : "▼"} {Math.abs(item.changePercent).toFixed(2)}%
                    </div>
                  </td>
                  <td className="py-2.5 text-right">
                    <span className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[9px] font-black border ${
                      item.aiStance === "BULL" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                      item.aiStance === "BEAR" ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                      "bg-slate-500/10 text-slate-400 border-slate-500/20"
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
    </GlassPanel>
  );
}
