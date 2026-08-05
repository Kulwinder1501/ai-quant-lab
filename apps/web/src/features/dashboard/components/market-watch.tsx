import { GlassPanel } from "../../../components/ui/glass-panel";

interface MarketWatchItem {
  symbol: string;
  price: string;
  changePercent: number;
  aiStance: "BULL" | "BEAR" | "NEUT";
}

const MOCK_WATCHLIST: MarketWatchItem[] = [
  { symbol: "NIFTY50", price: "24,534.15", changePercent: 0.2, aiStance: "BULL" },
  { symbol: "BANKNIFTY", price: "52,481.00", changePercent: 0.5, aiStance: "BULL" },
  { symbol: "FINNIFTY", price: "23,150.25", changePercent: -0.1, aiStance: "NEUT" },
  { symbol: "SENSEX", price: "80,720.50", changePercent: 0.1, aiStance: "NEUT" },
  { symbol: "HANG SENG", price: "17,650.00", changePercent: -1.2, aiStance: "BEAR" },
  { symbol: "NIKKEI 225", price: "39,120.00", changePercent: 0.8, aiStance: "BULL" },
  { symbol: "S&P 500", price: "5,410.25", changePercent: 0.3, aiStance: "NEUT" },
];

export function MarketWatch({ selectedSymbol, onSelect }: { selectedSymbol?: string, onSelect?: (s: string) => void }) {
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
            {MOCK_WATCHLIST.map((item) => {
              const isPos = item.changePercent >= 0;
              const isSelected = item.symbol === selectedSymbol;
              return (
                <tr 
                  key={item.symbol} 
                  onClick={() => onSelect?.(item.symbol)}
                  className={`group transition cursor-pointer ${isSelected ? 'bg-cyan-500/10' : 'hover:bg-white/[0.02]'}`}
                >
                  <td className={`py-2.5 font-bold truncate max-w-[80px] ${isSelected ? 'text-cyan-400' : 'text-slate-300 group-hover:text-white'}`}>
                    {isSelected && <span className="mr-1 text-[10px]">⚡</span>}
                    {item.symbol}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="text-slate-200">{item.price}</div>
                    <div className={`text-[10px] ${isPos ? "text-emerald-400" : "text-rose-400"}`}>
                      {isPos ? "▲" : "▼"} {Math.abs(item.changePercent)}%
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
