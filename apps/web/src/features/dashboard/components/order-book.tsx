"use client";

import { GlassPanel } from "../../../components/ui/glass-panel";

/**
 * Honest empty panel — live L2 order book is not wired. Previously invented Math.random depth.
 */
export function OrderBook() {
  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Order Book</h3>
        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-600">unavailable</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-2 text-center">
        <p className="text-[10px] leading-relaxed text-slate-500">
          No live depth feed is connected. This panel stays empty rather than showing mock bids/asks.
        </p>
      </div>
    </GlassPanel>
  );
}
