"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getApiV1Url } from "../../../features/research/api";
import { Target, CheckCircle2, XCircle, Clock } from "lucide-react";
import { formatNumber } from "../../../features/research/presentation";

interface ShadowSummary {
  outcome: string;
  count: string;
  total_r: string | null;
}

interface ShadowTrade {
  trade_idea_id: string;
  generated_at: string;
  side: string;
  entry_price: string;
  target_price: string;
  stop_loss: string;
  risk_reward: string;
  outcome: string;
  r_multiple: string | null;
  settled_at: string | null;
}

export default function GoldShadowLedgerPage() {
  const [strategy, setStrategy] = useState<string>("ict-structure-v1");
  const [summary, setSummary] = useState<ShadowSummary[]>([]);
  const [trades, setTrades] = useState<ShadowTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${getApiV1Url()}/gold-shadow?strategy=${strategy}`);
        if (!res.ok) throw new Error("Failed to fetch Gold shadow ledger");
        const data = await res.json();
        setSummary(data.summary);
        setTrades(data.trades);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [strategy]);

  if (loading) return <div className="p-8 text-white">Loading Gold Shadow Ledger...</div>;
  if (error) return <div className="p-8 text-red-400">Error: {error}</div>;

  let netPnL = 0;
  let wins = 0;
  let losses = 0;
  let unresolved = 0;
  
  summary.forEach(s => {
    if (s.total_r) netPnL += parseFloat(s.total_r);
    if (s.outcome === "TARGET") wins = parseInt(s.count);
    if (s.outcome === "STOP") losses = parseInt(s.count);
    if (s.outcome === "UNRESOLVED") unresolved = parseInt(s.count);
  });

  const totalClosed = wins + losses;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;

  return (
    <div className="flex h-full flex-col font-sans">
      <div className="px-6 py-4 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-white tracking-tight">
            <Target className="size-6 text-yellow-400" />
            Gold (XAU_USD) Shadow Ledger
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Tracking the live paper performance of the Gold bots in shadow mode.
          </p>
        </div>
        <div>
          <select 
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="bg-slate-800 text-white border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
          >
            <option value="ict-structure-v1">ICT Structure (ict-structure-v1)</option>
            <option value="momentum-scalp-gold">Momentum Scalp (momentum-scalp-gold)</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
        {/* Metrics Overview */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4 mb-8">
          <GlassPanel className="p-5 flex flex-col justify-center items-center">
            <p className="text-sm text-slate-400 font-medium">Net Shadow PnL</p>
            <p className={`text-3xl font-bold mt-2 ${netPnL >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {netPnL > 0 ? "+" : ""}{netPnL.toFixed(2)}R
            </p>
          </GlassPanel>
          <GlassPanel className="p-5 flex flex-col justify-center items-center">
            <p className="text-sm text-slate-400 font-medium">Win Rate</p>
            <p className="text-3xl font-bold text-white mt-2">
              {winRate.toFixed(1)}%
            </p>
            <p className="text-xs text-slate-500 mt-1">{wins}W - {losses}L</p>
          </GlassPanel>
          <GlassPanel className="p-5 flex flex-col justify-center items-center">
            <p className="text-sm text-slate-400 font-medium">Total Expired (Unresolved)</p>
            <p className="text-3xl font-bold text-slate-400 mt-2">
              {unresolved}
            </p>
          </GlassPanel>
          <GlassPanel className="p-5 flex flex-col justify-center items-center">
            <p className="text-sm text-slate-400 font-medium">Total Trades Generated</p>
            <p className="text-3xl font-bold text-white mt-2">
              {trades.length}
            </p>
          </GlassPanel>
        </div>

        {/* Ledger Table */}
        <GlassPanel className="flex flex-col flex-1 overflow-hidden">
          <div className="border-b border-white/5 bg-white/5 px-4 py-3">
            <h2 className="text-sm font-semibold text-white tracking-wide">SHADOW TRADE LOG (LAST 200)</h2>
          </div>
          <div className="overflow-auto flex-1 max-h-[500px] custom-scrollbar">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-white/5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3 whitespace-nowrap">Generated At</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3 text-right">Entry</th>
                  <th className="px-4 py-3 text-right">Target</th>
                  <th className="px-4 py-3 text-right">Stop</th>
                  <th className="px-4 py-3 text-right">R:R</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {trades.map((t) => (
                  <tr key={t.trade_idea_id} className="hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                      {new Date(t.generated_at).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold ${t.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
                        {t.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{formatNumber(parseFloat(t.entry_price), 2)}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-400/80">{formatNumber(parseFloat(t.target_price), 2)}</td>
                    <td className="px-4 py-3 text-right font-mono text-rose-400/80">{formatNumber(parseFloat(t.stop_loss), 2)}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatNumber(parseFloat(t.risk_reward), 2)}R</td>
                    <td className="px-4 py-3">
                      {t.outcome === "TARGET" && <span className="inline-flex items-center gap-1 text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded text-xs"><CheckCircle2 className="size-3" /> TARGET</span>}
                      {t.outcome === "STOP" && <span className="inline-flex items-center gap-1 text-rose-400 bg-rose-400/10 px-2 py-0.5 rounded text-xs"><XCircle className="size-3" /> STOP</span>}
                      {t.outcome === "UNRESOLVED" && <span className="inline-flex items-center gap-1 text-slate-400 bg-slate-400/10 px-2 py-0.5 rounded text-xs"><Clock className="size-3" /> EXPIRED</span>}
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${parseFloat(t.r_multiple || "0") > 0 ? "text-emerald-400" : parseFloat(t.r_multiple || "0") < 0 ? "text-rose-400" : "text-slate-500"}`}>
                      {t.r_multiple ? `${parseFloat(t.r_multiple).toFixed(2)}R` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}
