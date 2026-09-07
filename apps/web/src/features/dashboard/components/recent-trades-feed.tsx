"use client";

import { GlassPanel } from "../../../components/ui/glass-panel";

/**
 * Honest empty panel — tick-by-tick trade tape is not wired. Previously invented Math.random prints.
 */
export function RecentTradesFeed() {
  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Recent Trades</h3>
        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-600">unavailable</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-2 text-center">
        <p className="text-[10px] leading-relaxed text-slate-500">
          No live trade tape is connected. This panel stays empty rather than simulating prints.
        </p>
      </div>
    </GlassPanel>
  );
}
