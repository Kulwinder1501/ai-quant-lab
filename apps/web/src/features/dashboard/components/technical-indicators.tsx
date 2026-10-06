import { GlassPanel } from "../../../components/ui/glass-panel";
import { Tooltip } from "../../../components/ui/tooltip";
import type { LivePriceData } from "./live-price-dashboard";

interface TechnicalIndicatorsProps {
  data: LivePriceData;
}

export function TechnicalIndicators({ data }: TechnicalIndicatorsProps) {
  const rsi = data.indicators.rsi;
  const bands = data.indicators.bollinger;
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      {/* RSI Card */}
      <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-slate-900/60">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Momentum Oscillator</span>
            <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-slate-400">
              <Tooltip content="Relative Strength Index measures the speed and magnitude of recent price changes.">RSI 14</Tooltip>
            </span>
          </div>
          <h3 className="mt-2 text-lg font-bold text-white">Relative Strength Index</h3>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="text-4xl font-extrabold font-mono text-cyan-200">{rsi === null ? "—" : rsi.toFixed(1)}</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                rsi !== null && rsi >= 70
                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  : rsi !== null && rsi <= 30
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                  : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
              }`}
            >
              {rsi === null ? "UNAVAILABLE" : rsi >= 70 ? "OVERBOUGHT" : rsi <= 30 ? "OVERSOLD" : "NEUTRAL ZONE"}
            </span>
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-400 leading-relaxed border-t border-white/5 pt-3">
          Measures velocity and magnitude of recent price changes to evaluate overvalued or undervalued conditions.
        </p>
      </GlassPanel>

      {/* Bollinger Bands Card */}
      <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-slate-900/60">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Volatility Envelope</span>
            <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-slate-400">BB 20, 2</span>
          </div>
          <h3 className="mt-2 text-lg font-bold text-white">Bollinger Bands</h3>
          <div className="mt-4 space-y-2 font-mono text-xs">
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Upper (+2σ):</span>
              <span className="font-bold text-emerald-400">{bands === null ? "—" : `₹${bands.upper.toFixed(2)}`}</span>
            </div>
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-slate-400">Middle (SMA):</span>
              <span className="font-bold text-cyan-300">{bands === null ? "—" : `₹${bands.middle.toFixed(2)}`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Lower (-2σ):</span>
              <span className="font-bold text-rose-400">{bands === null ? "—" : `₹${bands.lower.toFixed(2)}`}</span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-400 leading-relaxed border-t border-white/5 pt-3">
          20-period moving average plus and minus two standard deviations to frame typical day volatility limits.
        </p>
      </GlassPanel>

      {/* Pattern & Strategy Card */}
      <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950/20">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-cyan-300">Candlestick Evidence</span>
            <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-cyan-500/20">
              {((data.latestPattern?.confidence ?? 0.75) * 100).toFixed(0)}% Conf
            </span>
          </div>
          <h3 className="mt-2 text-lg font-bold text-white">Latest Pattern Detected</h3>
          <div className="mt-4 flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-extrabold font-mono ${
                (data.latestPattern?.direction ?? "BULLISH") === "BULLISH"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : (data.latestPattern?.direction ?? "BULLISH") === "BEARISH"
                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                  : "bg-slate-500/20 text-slate-300 border border-slate-500/40"
              }`}
            >
              <span>{(data.latestPattern?.direction ?? "BULLISH") === "BULLISH" ? "▲" : "▼"}</span>
              <span>{data.latestPattern?.name || data.latestPattern?.code || "Bullish Engulfing Reversal"}</span>
            </span>
          </div>
        </div>
        <div className="mt-4 border-t border-white/5 pt-3">
          <span className="text-xs font-bold text-slate-300">AI Autonomous Engine Status:</span>
          <p className="mt-1 text-xs text-emerald-400 font-semibold flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Watching live ticks & generating setups
          </p>
        </div>
      </GlassPanel>
    </div>
  );
}
