import React, { memo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import type { AiBrainThought, LivePriceData } from "./live-price-dashboard";

interface AiBrainStreamProps {
  data: LivePriceData;
  thoughts: AiBrainThought[];
}

export const AiBrainStream = memo(function AiBrainStream({ data, thoughts }: AiBrainStreamProps) {
  return (
    <GlassPanel className="flex h-full min-h-0 flex-col p-6 md:p-8 border-cyan-500/40 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/30 shadow-2xl">
      <div className="flex shrink-0 flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/20 border border-cyan-400/30 text-2xl shadow-inner">
            🧠
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-black text-white">Autonomous Quant AI Brain</h3>
              <span className="rounded-full bg-cyan-400/10 px-2.5 py-0.5 text-[10px] font-extrabold font-mono text-cyan-300 border border-cyan-400/30">
                LIVE DECISION FEED
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Continuous multi-modal analysis across Indian technical indicators, candlestick pattern recognition, and news sentiment.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-black/40 px-4 py-2 border border-white/10 font-mono text-xs">
          <span className="text-slate-400">Execution Threshold:</span>
          <span className="font-bold text-emerald-400">≥ 80% Confidence</span>
        </div>
      </div>

      {/* Scrollable Live Thought Log */}
      <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2 custom-scrollbar font-mono text-xs">
        {thoughts.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 p-8 text-center text-slate-400">
            <span className="text-2xl animate-spin">⚙️</span>
            <p className="mt-2 font-sans font-bold">AI Brain is initializing market scans for {data.symbol}...</p>
            <span className="text-[10px] text-slate-500 font-sans">Decision logs will appear here every second.</span>
          </div>
        ) : (
          thoughts.map((th) => {
            let badgeColor = "bg-slate-700/60 text-slate-200 border-slate-500/50";
            let icon = "🔍";
            // The card's own surface, keyed to the same action as the badge. A flat near-black
            // panel read as a dead hole punched in the glass surface around it and, worse, gave
            // every entry the same weight -- an ANALYZING tick looked exactly as urgent as an
            // EXECUTING one. Tinting the surface makes the log skimmable by action instead of
            // requiring the badge to be read on each row.
            let surface = "border-slate-500/25 bg-slate-800/50 hover:bg-slate-800/70";
            let accent = "bg-slate-400/60";
            if (th.action === "EXECUTING") {
              badgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-md shadow-emerald-500/10";
              surface = "border-emerald-500/30 bg-emerald-950/40 hover:bg-emerald-950/60";
              accent = "bg-emerald-400";
              icon = "⚡";
            } else if (th.action === "PROPOSING") {
              badgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/50";
              surface = "border-amber-500/30 bg-amber-950/30 hover:bg-amber-950/50";
              accent = "bg-amber-400";
              icon = "💡";
            } else if (th.action === "LEARNING") {
              badgeColor = "bg-purple-500/20 text-purple-300 border-purple-500/50";
              surface = "border-purple-500/30 bg-purple-950/30 hover:bg-purple-950/50";
              accent = "bg-purple-400";
              icon = "🎓";
            } else if (th.action === "MONITORING") {
              badgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/50";
              surface = "border-blue-500/30 bg-blue-950/30 hover:bg-blue-950/50";
              accent = "bg-blue-400";
              icon = "👁️";
            }

            return (
              <div
                key={th.id}
                className={`relative overflow-hidden rounded-xl border p-4 pl-5 shadow-sm transition ${surface}`}
              >
                <span className={`absolute inset-y-0 left-0 w-1 ${accent}`} aria-hidden="true" />
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">{icon}</span>
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold tracking-wider border ${badgeColor}`}>
                      {th.action}
                    </span>
                    <span className="font-bold text-slate-200">{th.symbol}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    <span>
                      Confidence:{" "}
                      <strong className={th.confidence >= 80 ? "text-emerald-400 font-extrabold" : "text-cyan-300"}>
                        {th.confidence}%
                      </strong>
                    </span>
                    <span>•</span>
                    <span>{new Date(th.timestamp).toLocaleTimeString("en-IN")}</span>
                  </div>
                </div>

                <p className="mt-2.5 font-sans text-sm font-medium text-slate-200 leading-relaxed">{th.message}</p>

                {th.details && Object.keys(th.details).length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-2 pt-2 border-t border-white/5 text-[11px] text-slate-400">
                    {Boolean(th.details.rsi) && (
                      <span className="rounded bg-white/5 px-2 py-0.5">RSI: {String(th.details.rsi)}</span>
                    )}
                    {Boolean(th.details.pattern) && String(th.details.pattern) !== "NONE" && (
                      <span className="rounded bg-cyan-500/10 text-cyan-300 px-2 py-0.5 border border-cyan-500/20">
                        Pattern: {String(th.details.pattern)}
                      </span>
                    )}
                    {Boolean(th.details.newsSentiment) && (
                      <span className="rounded bg-purple-500/10 text-purple-300 px-2 py-0.5 border border-purple-500/20">
                        News: {String(th.details.newsSentiment)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </GlassPanel>
  );
}, (prev, next) => {
  return (
    prev.data.symbol === next.data.symbol &&
    prev.thoughts === next.thoughts
  );
});
