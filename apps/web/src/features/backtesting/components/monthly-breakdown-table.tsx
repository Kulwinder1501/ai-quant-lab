import React from "react";
import { formatNumber } from "../../research/presentation";
import type { BacktestMonthlyPerformanceRow } from "../domain";

interface MonthlyBreakdownTableProps {
  monthlyPerformance: BacktestMonthlyPerformanceRow[];
}

export function MonthlyBreakdownTable({ monthlyPerformance }: MonthlyBreakdownTableProps) {
  if (monthlyPerformance.length === 0) {
    return <div className="py-8 text-center text-xs text-slate-500">No monthly performance breakdown recorded.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <th className="py-3 px-4">Month</th>
            <th className="py-3 px-4">Trades</th>
            <th className="py-3 px-4">Wins / Losses</th>
            <th className="py-3 px-4">Gross Profit</th>
            <th className="py-3 px-4">Gross Loss</th>
            <th className="py-3 px-4">Net P&amp;L (₹)</th>
            <th className="py-3 px-4">Max Drawdown</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 text-xs">
          {monthlyPerformance.map((m, idx) => {
            const net = m.netPnl || 0;
            const losses = (m.tradeCount || 0) - (m.winningTradeCount || 0);
            return (
              <tr key={idx} className="hover:bg-white/[0.02] transition">
                <td className="py-3.5 px-4 font-bold text-white font-mono">{m.monthStart}</td>
                <td className="py-3.5 px-4 font-semibold text-slate-200">{m.tradeCount}</td>
                <td className="py-3.5 px-4">
                  <span className="text-emerald-400 font-bold">{m.winningTradeCount}W</span>
                  <span className="text-slate-500 mx-1">/</span>
                  <span className="text-rose-400 font-bold">{losses}L</span>
                </td>
                <td className="py-3.5 px-4 text-emerald-400 font-semibold">+₹{formatNumber(m.grossProfit, 2)}</td>
                <td className="py-3.5 px-4 text-rose-400 font-semibold">-₹{formatNumber(m.grossLoss, 2)}</td>
                <td className={`py-3.5 px-4 font-extrabold text-sm ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {net >= 0 ? "+" : ""}₹{formatNumber(net, 2)}
                </td>
                <td className="py-3.5 px-4 text-rose-400 font-semibold">-{formatNumber(m.maxDrawdownPercent, 2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
