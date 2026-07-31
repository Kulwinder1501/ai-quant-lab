import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import type { PaperTradeRow } from "../domain";

function lotSizeForSymbol(symbol?: string): number {
  if (symbol === "BANKNIFTY") return 15;
  if (symbol === "NIFTY50") return 75;
  return 1;
}

function formatLots(quantity: number, symbol?: string): string {
  const lot = lotSizeForSymbol(symbol);
  if (lot <= 1 || quantity % lot !== 0) return `${formatNumber(quantity, 0)} units`;
  return `${quantity / lot} lots (${formatNumber(quantity, 0)})`;
}

interface TradeHistoryTableProps {
  closedTrades: PaperTradeRow[];
}

export function TradeHistoryTable({ closedTrades }: TradeHistoryTableProps) {
  return (
    <GlassPanel className="p-6 border-white/10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-white">Trade History ({closedTrades.length})</h2>
          <p className="text-xs text-slate-400">Completed simulated trades with net P&amp;L after brokerage and statutory charges.</p>
        </div>
      </div>

      {closedTrades.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">No completed trade history yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="py-3 px-4">Instrument</th>
                <th className="py-3 px-4">Side</th>
                <th className="py-3 px-4">Qty</th>
                <th className="py-3 px-4">Entry / Exit</th>
                <th className="py-3 px-4">Total Fees</th>
                <th className="py-3 px-4">Net P&amp;L</th>
                <th className="py-3 px-4">Return %</th>
                <th className="py-3 px-4">Exit Reason</th>
                <th className="py-3 px-4">Closed At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm">
              {closedTrades.map((trade) => {
                const pnl = trade.realizedPnl || 0;
                const fees = trade.entryFees || 0;
                const ret = trade.returnPercent || 0;
                const gross = pnl + fees;
                return (
                  <tr key={trade.id} className="hover:bg-white/[0.02] transition">
                    <td className="py-3.5 px-4 font-bold text-white">
                      {trade.instrumentSymbol || "NIFTY50"}
                      <span className="block text-xs font-normal text-slate-500">{trade.timeframe || "1d"}</span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                        trade.side === "BUY" || trade.side === "LONG" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                      }`}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-medium text-slate-200">{formatLots(trade.quantity, trade.instrumentSymbol)}</td>
                    <td className="py-3.5 px-4 text-xs text-slate-300">
                      <div>In: ₹{formatNumber(trade.fillPrice, 2)}</div>
                      <div className="font-semibold text-white">Out: ₹{formatNumber(trade.exitPrice || 0, 2)}</div>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-300" title={JSON.stringify(trade.feeBreakdown || {})}>
                      ₹{formatNumber(fees, 2)}
                      <span className="block text-[10px] text-slate-500">gross ₹{formatNumber(gross, 2)}</span>
                    </td>
                    <td className={`py-3.5 px-4 font-bold ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {pnl >= 0 ? "+" : ""}₹{formatNumber(pnl, 2)}
                    </td>
                    <td className={`py-3.5 px-4 font-semibold ${ret >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      {ret >= 0 ? "+" : ""}{formatNumber(ret, 2)}%
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300 border border-white/10 font-mono">
                        {trade.exitReason || "MANUAL"}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">{formatTimestamp(trade.closedAt || null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}
