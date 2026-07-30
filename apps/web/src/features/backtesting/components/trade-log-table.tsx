import React from "react";
import { formatNumber, formatTimestamp } from "../../research/presentation";

interface TradeLogTableProps {
  trades: any[];
}

export function TradeLogTable({ trades }: TradeLogTableProps) {
  if (trades.length === 0) {
    return <div className="py-8 text-center text-xs text-slate-500">No simulated trades executed in this window.</div>;
  }

  return (
    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-slate-400 sticky top-0 bg-slate-950 z-10">
            <th className="py-3 px-3">Side</th>
            <th className="py-3 px-3">Qty</th>
            <th className="py-3 px-3">Entry Price / Time</th>
            <th className="py-3 px-3">Exit Price / Time</th>
            <th className="py-3 px-3">P&amp;L (₹)</th>
            <th className="py-3 px-3">Return %</th>
            <th className="py-3 px-3">Exit Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 text-xs">
          {trades.map((t) => {
            const p = t.pnl || 0;
            const r = t.returnPercent || 0;
            return (
              <tr key={t.id} className="hover:bg-white/[0.02] transition">
                <td className="py-3 px-3">
                  <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-extrabold ${
                    t.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  }`}>
                    {t.side}
                  </span>
                </td>
                <td className="py-3 px-3 font-semibold text-slate-200">{formatNumber(t.quantity, 0)}</td>
                <td className="py-3 px-3">
                  <div className="font-bold text-white">₹{formatNumber(t.entryPrice, 2)}</div>
                  <div className="text-[10px] text-slate-500">{formatTimestamp(t.entryTime)}</div>
                </td>
                <td className="py-3 px-3">
                  <div className="font-bold text-white">₹{formatNumber(t.exitPrice, 2)}</div>
                  <div className="text-[10px] text-slate-500">{formatTimestamp(t.exitTime)}</div>
                </td>
                <td className={`py-3 px-3 font-extrabold ${p >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {p >= 0 ? "+" : ""}₹{formatNumber(p, 2)}
                </td>
                <td className={`py-3 px-3 font-semibold ${r >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {r >= 0 ? "+" : ""}{formatNumber(r, 2)}%
                </td>
                <td className="py-3 px-3">
                  <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-slate-900 text-slate-300 border border-white/10 font-mono">
                    {t.exitReason || "TARGET"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
