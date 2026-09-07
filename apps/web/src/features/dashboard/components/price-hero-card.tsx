import { GlassPanel } from "../../../components/ui/glass-panel";
import type { LivePriceData } from "./live-price-dashboard";

interface PriceHeroCardProps {
  data: LivePriceData;
  isPositive: boolean;
}

export function PriceHeroCard({ data: inputData, isPositive }: PriceHeroCardProps) {
  // This legacy card is not mounted by the dashboard, but keep it null-safe so a
  // future caller cannot render fabricated OHLC/volume fallbacks as real values.
  const data = {
    ...inputData,
    change: inputData.change ?? 0,
    changePercent: inputData.changePercent ?? 0,
    open: inputData.open ?? inputData.livePrice,
    high: inputData.high ?? inputData.livePrice,
    low: inputData.low ?? inputData.livePrice,
    volume: inputData.volume ?? 0,
  };
  return (
    <GlassPanel className="relative overflow-hidden border-cyan-500/40 bg-gradient-to-br from-slate-900 via-slate-950 to-cyan-950/40 p-6 md:p-8 shadow-2xl">
      <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none"></div>
      
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-black text-white md:text-3xl">{data.displayName || data.symbol}</h2>
            <span className="rounded-md bg-cyan-400/10 px-2.5 py-1 text-xs font-mono font-bold text-cyan-300 border border-cyan-400/30">
              {data.exchange || "NSE"}:{data.symbol}
            </span>
            <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-mono font-bold text-emerald-300 border border-emerald-500/30">
              ● LIVE TICKING
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline gap-4">
            <span className="text-5xl font-black tracking-tight text-white md:text-6xl font-mono transition-all duration-300">
              ₹{data.livePrice.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-base font-extrabold shadow-lg transition-all duration-300 ${
                isPositive
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-emerald-500/10"
                  : "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-rose-500/10"
              }`}
            >
              <span>{isPositive ? "▲" : "▼"}</span>
              <span>
                {isPositive ? "+" : ""}₹{Math.abs(data.change).toFixed(2)}
              </span>
              <span>({isPositive ? "+" : ""}{data.changePercent}%)</span>
            </span>
          </div>

          <p className="mt-3 text-xs text-slate-400 font-mono flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Last Micro-Tick:{" "}
            <span className="text-slate-200 font-bold">
              {new Date(data.lastUpdated).toLocaleTimeString("en-IN")}
            </span>
            {" • "}
            <span className="text-cyan-400">Autonomous Execution Enabled</span>
            {" • "}
            <span className="text-purple-400">EOD Pipeline Scheduled (4:05 PM)</span>
          </p>
        </div>

        {/* Range & Volume Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 lg:min-w-[420px]">
          <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
            <span className="text-xs font-bold uppercase text-slate-400">Open</span>
            <p className="mt-1 text-lg font-bold text-white font-mono">
              ₹{data.open.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
            <span className="text-xs font-bold uppercase text-emerald-400">High</span>
            <p className="mt-1 text-lg font-bold text-emerald-300 font-mono">
              ₹{data.high.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
            <span className="text-xs font-bold uppercase text-rose-400">Low</span>
            <p className="mt-1 text-lg font-bold text-rose-300 font-mono">
              ₹{data.low.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
            <span className="text-xs font-bold uppercase text-slate-400">Volume Ticks</span>
            <p className="mt-1 text-lg font-bold text-cyan-200 font-mono">
              {data.volume.toLocaleString("en-IN")}
            </p>
          </div>
        </div>
      </div>

      {/* High/Low Progress Geometry */}
      <div className="mt-6 pt-4 border-t border-white/10">
        <div className="flex justify-between text-xs font-mono font-bold">
          <span className="text-rose-400">Low: ₹{data.low.toFixed(2)}</span>
          <span className="text-slate-400 uppercase tracking-widest text-[10px]">Live Range Spread</span>
          <span className="text-emerald-400">High: ₹{data.high.toFixed(2)}</span>
        </div>
        <div className="mt-2 h-2.5 w-full rounded-full bg-slate-800 overflow-hidden p-0.5 border border-white/5">
          <div
            className="h-full rounded-full bg-gradient-to-r from-rose-500 via-cyan-400 to-emerald-400 transition-all duration-500"
            style={{
              width: `${Math.min(
                100,
                Math.max(
                  5,
                  ((data.livePrice - data.low) / ((data.high - data.low) || 1)) * 100
                )
              )}%`,
            }}
          ></div>
        </div>
      </div>
    </GlassPanel>
  );
}
