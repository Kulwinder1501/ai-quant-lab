"use client";

import { useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface OrderBookRow {
  price: string;
  size: string;
  total: number;
}

function createMockOrderBook(): { asks: OrderBookRow[]; bids: OrderBookRow[] } {
    // Generate mock order book
    const mockAsks: OrderBookRow[] = [];
    const mockBids: OrderBookRow[] = [];
    
    let currentAskTotal = 0;
    let currentBidTotal = 0;
    
    for (let i = 0; i < 8; i++) {
      const sizeAsk = Math.random() * 5 + 0.1;
      currentAskTotal += sizeAsk;
      mockAsks.push({
        price: (24534.15 + (i * 0.5) + 0.5).toFixed(2),
        size: sizeAsk.toFixed(3),
        total: currentAskTotal
      });

      const sizeBid = Math.random() * 5 + 0.1;
      currentBidTotal += sizeBid;
      mockBids.push({
        price: (24534.15 - (i * 0.5) - 0.5).toFixed(2),
        size: sizeBid.toFixed(3),
        total: currentBidTotal
      });
    }

  return { asks: mockAsks.reverse(), bids: mockBids };
}

export function OrderBook() {
  const [{ asks, bids }] = useState(createMockOrderBook);

  const maxTotal = Math.max(
    ...asks.map(a => a.total),
    ...bids.map(b => b.total),
    1
  );

  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Order Book</h3>
        <span className="text-[9px] text-slate-500">L2 DATA</span>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col font-mono text-[10px]">
        {/* Asks (Red) */}
        <div className="flex-1 overflow-hidden flex flex-col justify-end">
          {asks.map((ask, i) => {
            const width = `${(ask.total / maxTotal) * 100}%`;
            return (
              <div key={i} className="relative flex justify-between py-1 px-1 hover:bg-white/[0.02] cursor-pointer">
                <div className="absolute right-0 top-0 bottom-0 bg-rose-500/10 z-0" style={{ width }} />
                <span className="text-rose-400 z-10">{ask.price}</span>
                <span className="text-slate-300 z-10">{ask.size}</span>
              </div>
            );
          })}
        </div>
        
        {/* Spread */}
        <div className="py-2 my-1 border-y border-white/[0.02] flex items-center justify-between px-1 text-slate-400 text-xs">
          <span className="font-sans text-[10px]">SPREAD</span>
          <span className="font-bold">1.00</span>
        </div>

        {/* Bids (Green) */}
        <div className="flex-1 overflow-hidden flex flex-col justify-start">
          {bids.map((bid, i) => {
            const width = `${(bid.total / maxTotal) * 100}%`;
            return (
              <div key={i} className="relative flex justify-between py-1 px-1 hover:bg-white/[0.02] cursor-pointer">
                <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 z-0" style={{ width }} />
                <span className="text-emerald-400 z-10">{bid.price}</span>
                <span className="text-slate-300 z-10">{bid.size}</span>
              </div>
            );
          })}
        </div>
      </div>
    </GlassPanel>
  );
}
