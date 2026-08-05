"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface TradePrint {
  id: number;
  time: string;
  price: string;
  amount: string;
  side: "BUY" | "SELL";
}

export function RecentTradesFeed() {
  const [trades, setTrades] = useState<TradePrint[]>([]);

  useEffect(() => {
    // Generate initial mock trades
    const initial: TradePrint[] = Array.from({ length: 15 }).map((_, i) => ({
      id: i,
      time: new Date(Date.now() - i * 2000).toISOString().substr(11, 8),
      price: (24534.15 + (Math.random() * 10 - 5)).toFixed(2),
      amount: (Math.random() * 3 + 0.1).toFixed(3),
      side: Math.random() > 0.5 ? "BUY" : "SELL"
    }));
    setTrades(initial);

    // Simulate ticking
    const interval = setInterval(() => {
      setTrades(prev => {
        const newTrade: TradePrint = {
          id: Date.now(),
          time: new Date().toISOString().substr(11, 8),
          price: (24534.15 + (Math.random() * 10 - 5)).toFixed(2),
          amount: (Math.random() * 3 + 0.1).toFixed(3),
          side: Math.random() > 0.5 ? "BUY" : "SELL"
        };
        return [newTrade, ...prev].slice(0, 15);
      });
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Recent Trades</h3>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col font-mono text-[10px]">
        <div className="flex justify-between px-1 pb-2 text-[9px] text-slate-500 uppercase">
          <span>Price</span>
          <span>Amount</span>
          <span>Time</span>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {trades.map((trade) => (
            <div key={trade.id} className="flex justify-between py-1 px-1 hover:bg-white/[0.02]">
              <span className={trade.side === "BUY" ? "text-emerald-400" : "text-rose-400"}>
                {trade.price}
              </span>
              <span className="text-slate-300">{trade.amount}</span>
              <span className="text-slate-500">{trade.time}</span>
            </div>
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}
