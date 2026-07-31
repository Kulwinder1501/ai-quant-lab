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
  return `${quantity / lot} lots (${formatNumber(quantity, 0)} units)`;
}

interface ActivePositionsTableProps {
  openTrades: PaperTradeRow[];
  pendingTrades: PaperTradeRow[];
  loading: boolean;
  onCloseTrade: (trade: PaperTradeRow) => void;
}

export function ActivePositionsTable({ openTrades, pendingTrades, loading, onCloseTrade }: ActivePositionsTableProps) {
  const activeTrades = [...pendingTrades, ...openTrades];
  return (
    <GlassPanel className="p-6 border-white/10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-white">Active Simulated Positions ({activeTrades.length})</h2>
          <p className="text-xs text-slate-400">Positions evaluated against market candles and take-profit/stop-loss targets.</p>
        </div>
      </div>

      {loading && activeTrades.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading portfolio positions...</div>
      ) : activeTrades.length === 0 ? (
        <div className="py-10 text-center rounded-xl border border-dashed border-white/10 bg-white/5">
          <p className="text-sm font-semibold text-slate-300">No active simulated trades</p>
          <p className="text-xs text-slate-500 mt-1">Click &quot;Simulate Trade&quot; above to open a position from an AI strategy proposal.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="py-3 px-4">Instrument</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Side</th>
                <th className="py-3 px-4">Qty</th>
                <th className="py-3 px-4">Entry Price</th>
                <th className="py-3 px-4">Fees</th>
                <th className="py-3 px-4">Opened At</th>
                <th className="py-3 px-4">Notes</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm">
              {activeTrades.map((trade) => (
                <tr key={trade.id} className="hover:bg-white/[0.02] transition">
                  <td className="py-3.5 px-4 font-bold text-white">
                    {trade.instrumentSymbol || "NIFTY50"}
                    <span className="block text-xs font-normal text-slate-500">{trade.timeframe || "1d"}</span>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                      trade.status === "PENDING" ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    }`}>
                      {trade.status}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                      trade.side === "BUY" || trade.side === "LONG" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    }`}>
                      {trade.side}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-medium text-slate-200">
                    {formatLots(trade.quantity, trade.instrumentSymbol)}
                  </td>
                  <td className="py-3.5 px-4 font-semibold text-white">₹{formatNumber(trade.fillPrice, 2)}</td>
                  <td className="py-3.5 px-4 text-xs text-slate-300" title={JSON.stringify(trade.feeBreakdown || {})}>
                    ₹{formatNumber(trade.entryFees || 0, 2)}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                  <td className="py-3.5 px-4 text-xs text-slate-400 max-w-xs truncate">{trade.notes || "—"}</td>
                  <td className="py-3.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => onCloseTrade(trade)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/30 transition"
                    >
                      Close Position
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}
