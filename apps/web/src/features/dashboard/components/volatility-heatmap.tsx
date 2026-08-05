"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";

export function VolatilityHeatmap() {
  const [blocks, setBlocks] = useState<number[]>([]);

  useEffect(() => {
    // Generate some random mockup volatility data (-1 to 1)
    const data = Array.from({ length: 48 }).map(() => (Math.random() * 2) - 1);
    setBlocks(data);
  }, []);

  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 rounded-md">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-3">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <span className="h-3 w-3 grid grid-cols-2 gap-[1px]">
            <span className="bg-emerald-400 rounded-sm"></span>
            <span className="bg-rose-400 rounded-sm"></span>
            <span className="bg-slate-400 rounded-sm"></span>
            <span className="bg-cyan-400 rounded-sm"></span>
          </span>
          Volatility Heatmap (24H)
        </h3>
      </div>
      <div className="grid grid-cols-12 gap-1 sm:gap-1.5">
        {blocks.map((val, idx) => {
          // Map value -1 to 1 to a tailwind color
          let colorClass = "bg-slate-700/50";
          if (val > 0.6) colorClass = "bg-emerald-400";
          else if (val > 0.2) colorClass = "bg-emerald-500/60";
          else if (val > 0) colorClass = "bg-emerald-500/20";
          else if (val > -0.2) colorClass = "bg-rose-500/20";
          else if (val > -0.6) colorClass = "bg-rose-500/60";
          else colorClass = "bg-rose-400";

          return (
            <div 
              key={idx} 
              className={`aspect-square rounded-sm sm:rounded ${colorClass} transition-colors duration-500`}
              title={`Vol sector ${idx}: ${val.toFixed(2)}`}
            />
          );
        })}
      </div>
    </GlassPanel>
  );
}
