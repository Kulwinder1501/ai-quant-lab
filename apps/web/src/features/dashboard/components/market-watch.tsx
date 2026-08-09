import { GlassPanel } from "../../../components/ui/glass-panel";

import { useEffect, useState } from "react";
import { getApiV1Url } from "../../research/api";

interface MarketWatchItem {
  symbol: string;
  price: string | number;
  changePercent: number;
  aiStance: "BULL" | "BEAR" | "NEUT";
}

export function MarketWatch({ selectedSymbol, onSelect }: { selectedSymbol?: string, onSelect?: (s: string) => void }) {
  const [watchlist, setWatchlist] = useState<MarketWatchItem[]>([]);
  const [flashing, setFlashing] = useState<Record<string, string>>({}); // symbol -> 'up' | 'down'
  
  useEffect(() => {
    const es = new EventSource(`${getApiV1Url()}/stream/market-watch`);
    
    es.onmessage = (event) => {
      try {
        const data: MarketWatchItem[] = JSON.parse(event.data);
        
        setWatchlist(prev => {
          const newFlashing: Record<string, string> = {};
          
          data.forEach(newItem => {
            const oldItem = prev.find(p => p.symbol === newItem.symbol);
            if (oldItem && Number(oldItem.price) !== Number(newItem.price)) {
              newFlashing[newItem.symbol] = Number(newItem.price) > Number(oldItem.price) ? 'up' : 'down';
            }
          });
          
          if (Object.keys(newFlashing).length > 0) {
            setFlashing(newFlashing);
            setTimeout(() => setFlashing({}), 800);
          }
          
          return data;
        });
      } catch {}
    };

    return () => es.close();
  }, []);

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
              
              let rowClass = isSelected ? 'bg-cyan-500/10' : 'hover:bg-white/[0.02]';
              if (flash === 'up') rowClass = 'bg-emerald-500/20 transition-none';
              if (flash === 'down') rowClass = 'bg-rose-500/20 transition-none';
              
              return (
                <tr 
                  key={item.symbol} 
                  onClick={() => onSelect?.(item.symbol)}
                  className={`group transition-all duration-300 cursor-pointer ${rowClass}`}
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
