import React from "react";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import type { TradeIdeaRow } from "../domain";

interface ProposalsGridProps {
  filteredIdeas: TradeIdeaRow[];
  loading: boolean;
  ideasLength: number;
  openSimulateModal: (idea: TradeIdeaRow) => void;
}

export function ProposalsGrid({
  filteredIdeas,
  loading,
  ideasLength,
  openSimulateModal,
}: ProposalsGridProps) {
  if (loading && ideasLength === 0) {
    return <div className="py-12 text-center text-sm text-slate-400">Loading strategy proposals from database...</div>;
  }
  
  if (filteredIdeas.length === 0) {
    return (
      <div className="py-12 text-center rounded-xl border border-dashed border-white/10 bg-white/5">
        <p className="text-sm font-semibold text-slate-300">No active proposals</p>
        <p className="text-xs text-slate-500 mt-1">
          Expired historical setups are hidden. Click &quot;Generate Proposals&quot; to evaluate the latest settled candle, or pick a date filter for a specific session.
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredIdeas.map((idea) => {
          // Sides are persisted as "LONG"/"SHORT"; the previous check against
          // "BUY" never matched, so every badge — long or short — rendered with
          // the bearish red styling. A LONG is the bullish/green side.
          const isBuy = idea.side === "LONG" || idea.side === "BUY";
          const rr = idea.riskReward || 0;
          return (
            <div
              key={idea.id}
              className="rounded-2xl border border-white/10 bg-slate-950/60 p-5 hover:border-cyan-500/30 transition flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-xs font-mono font-semibold text-slate-400">
                      {idea.candleTimeframe || "1d"} • {formatTimestamp(idea.candleCloseTime || null)}
                    </span>
                    <h3 className="text-lg font-extrabold text-white mt-0.5">{idea.instrumentSymbol}</h3>
                    <p className="text-xs text-slate-400 truncate max-w-[180px]">{idea.instrumentName}</p>
                    {idea.strategyKey && (
                      <span className="mt-1 inline-flex rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-400">
                        {idea.strategyKey}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-extrabold tracking-wide ${
                      isBuy ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    }`}>
                      {idea.side}
                    </span>
                    <span className="text-xs font-semibold text-cyan-300">
                      Conf: {formatPercentage(idea.confidence)}
                    </span>
                    {idea.status && idea.status !== "PROPOSED" && (
                      <span className="text-[10px] font-mono font-semibold text-slate-500">{idea.status}</span>
                    )}
                    {idea.expiresAt && (
                      <span className="text-[10px] font-mono text-slate-500">
                        Exp {formatTimestamp(idea.expiresAt)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 py-3 px-3.5 rounded-xl bg-slate-900/80 border border-white/5 text-center">
                  <div>
                    <span className="block text-[10px] uppercase font-semibold text-slate-500">Entry</span>
                    <span className="text-sm font-bold text-white">₹{formatNumber(idea.entryPrice, 2)}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase font-semibold text-slate-500">Target</span>
                    <span className="text-sm font-bold text-emerald-400">₹{formatNumber(idea.targetPrice, 2)}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase font-semibold text-slate-500">Stop Loss</span>
                    <span className="text-sm font-bold text-rose-400">₹{formatNumber(idea.stopLoss, 2)}</span>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-slate-400 px-1">
                  <span>Risk : Reward Ratio</span>
                  <span className="font-bold text-amber-300">1 : {formatNumber(rr, 2)}</span>
                </div>

                {Array.isArray(idea.reasoning) && idea.reasoning.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/10 space-y-1">
                    <span className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Rule Evaluation Notes</span>
                    <ul className="text-xs text-slate-300 space-y-1 max-h-24 overflow-y-auto pr-1">
                      {idea.reasoning.slice(0, 3).map((r: any, idx: number) => (
                        <li key={idx} className="flex items-center gap-1.5">
                          <span className={r.passed ? "text-emerald-400 font-bold" : "text-slate-500"}>{r.passed ? "✓" : "•"}</span>
                          <span className="truncate">{r.rule || JSON.stringify(r)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between">
                <span className="text-[10px] font-mono text-slate-500 truncate max-w-[120px]">
                  ID: {idea.id.slice(0, 8)}...
                </span>
                <button
                  type="button"
                  onClick={() => openSimulateModal(idea)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 transition shadow-sm"
                >
                  🚀 Simulate in Portfolio
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
