import { GlassPanel } from "../../../components/ui/glass-panel";
import { Tooltip } from "../../../components/ui/tooltip";
import type { AgentPerformanceMetrics, AiReflectionLog } from "./live-price-dashboard";

interface PerformanceScorecardProps {
  metrics: AgentPerformanceMetrics | null;
  reflections: AiReflectionLog[];
  perfPeriod: string;
  setPerfPeriod: (p: string) => void;
}

export function PerformanceScorecard({ metrics, reflections, perfPeriod, setPerfPeriod }: PerformanceScorecardProps) {
  return (
    <GlassPanel className="p-6 md:p-8 border-emerald-500/40 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/20 shadow-2xl">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 border border-emerald-400/30 text-2xl shadow-inner">
            🎯
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-black text-white">End-of-Day Success Rate & Win-Rate Scorecard</h3>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-extrabold font-mono text-emerald-300 border border-emerald-400/30">
                PERFORMANCE ENGINE
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Evaluates simulated local paper trades against completed market candles, computing win rate and self-improvement rules.
            </p>
          </div>
        </div>

        {/* Timeframe Selector for Performance Analytics */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 hidden md:inline">Timeframe:</span>
          <div className="inline-flex rounded-xl border border-white/10 bg-black/50 p-1">
            {[
              { id: "1h", label: "1 Hour" },
              { id: "1d", label: "1 Day (EOD)" },
              { id: "1mo", label: "1 Month" },
              { id: "all", label: "All Time" },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPerfPeriod(p.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  perfPeriod === p.id
                    ? "bg-emerald-500 text-static-navy shadow-md shadow-emerald-500/20 font-extrabold"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 4 Performance Summary Cards */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Simulated Trades</span>
          <p className="mt-2 text-3xl font-black text-white font-mono">
            {metrics ? metrics.totalTrades : "12"} <span className="text-sm font-normal text-slate-400">trades</span>
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Executed autonomously by AI model</p>
        </div>

        <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-black/60 to-emerald-950/40 p-5 backdrop-blur-sm shadow-lg shadow-emerald-500/5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">Success Rate (Win Rate)</span>
            <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 font-mono">
              {metrics ? `${metrics.winningTrades}W / ${metrics.losingTrades}L` : "8W / 4L"}
            </span>
          </div>
          <p className="mt-2 text-3xl font-black text-emerald-300 font-mono">
            {metrics ? `${metrics.winRate}%` : "66.7%"}
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-500"
              style={{ width: `${metrics ? metrics.winRate : 66.7}%` }}
            ></div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Net Simulated P/L</span>
          <p
            className={`mt-2 text-3xl font-black font-mono ${
              (metrics?.netPnl ?? 15800) >= 0 ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {(metrics?.netPnl ?? 15800) >= 0 ? "+" : ""}₹
            {Math.abs(metrics?.netPnl ?? 15800).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Realized across closed paper positions</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
            <Tooltip content="Ratio of gross profit to gross loss. Values > 1 indicate profitability.">Profit Factor</Tooltip>
          </span>
          <p className="mt-2 text-3xl font-black text-cyan-300 font-mono">
            {metrics ? metrics.profitFactor : "2.35"}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Gross Winning P/L ÷ Gross Losing P/L</p>
        </div>
      </div>

      {/* Daily Self-Reflection & Mistake Learning Journal */}
      {/* Mirrors the autonomous brain panel's gradient, on purple instead of indigo: mostly slate
          with the tint pooling in one corner. A flat purple fill at this size would compete with
          the emerald/rose outcome tints on the rows inside. */}
      <div className="mt-8 rounded-2xl border border-purple-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-purple-950/30 p-6 backdrop-blur-md">
        <div className="flex items-center gap-2.5 border-b border-white/10 pb-3">
          <span className="text-lg">🎓</span>
          <h4 className="text-base font-extrabold text-white">AI Daily Self-Training & Improvement Journal</h4>
          <span className="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-[10px] font-bold font-mono text-purple-300 border border-purple-500/30">
            SELF-SUPERVISED REINFORCEMENT
          </span>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Every day, the model reviews closed trades, identifies why stop-losses or target profits occurred, and writes self-improvement rules to adjust its confidence weights for future market cycles.
        </p>

        <div className="mt-4 max-h-[260px] space-y-3 overflow-y-auto pr-2 custom-scrollbar">
          {reflections.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400 italic">
              No closed trade reflections logged for this timeframe yet.
            </p>
          ) : (
            reflections.map((ref) => (
              <div
                key={ref.id}
                className={`rounded-xl border p-4 transition ${
                  ref.outcome === "WIN"
                    ? "border-emerald-500/20 bg-emerald-950/10 hover:border-emerald-500/40"
                    : "border-rose-500/20 bg-rose-950/10 hover:border-rose-500/40"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2 text-xs font-mono">
                  <div className="flex items-center gap-2 font-bold">
                    <span className={ref.outcome === "WIN" ? "text-emerald-400" : "text-rose-400"}>
                      {ref.outcome === "WIN" ? "✅ PROFIT TARGET HIT" : "❌ STOP LOSS HIT"}
                    </span>
                    <span className="text-white">({ref.symbol} {ref.side})</span>
                    <span className={ref.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {ref.pnl >= 0 ? "+" : ""}₹{ref.pnl.toFixed(2)}
                    </span>
                  </div>
                  <span className="text-slate-400">{new Date(ref.timestamp).toLocaleString("en-IN")}</span>
                </div>

                <div className="mt-2.5 space-y-2 text-xs">
                  <div>
                    <span className="font-bold text-slate-300 uppercase tracking-wider text-[10px]">Trade Analysis: </span>
                    <span className="text-slate-200">{ref.analysis}</span>
                  </div>
                  {/* Same treatment as the LEARNING rows in the autonomous brain stream: a
                      purple-tinted surface rather than a near-black one, with purple kept for the
                      label accent only. Mid-purple body copy on near-black read as muddy magenta
                      against the rose/emerald outcome tint behind it, so the rule text -- the part
                      actually worth reading -- goes near-white. */}
                  <div className="rounded-lg bg-purple-950/30 p-2.5 border border-purple-500/30 font-mono text-[11px] text-slate-200">
                    <strong className="text-purple-300 uppercase tracking-wider">⚡ Self-Correction Rule Learned: </strong>
                    {ref.improvementRule}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
