import { formatNumber, formatTimestamp } from "../../research/presentation";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { DataTable } from "../../../components/ui/data-table";
import type { PaperAccountFullSummary, PaperTradeRow } from "../../paper-trading/domain";

/** `DataTable` and `exportToCsv` require an index signature, which an interface does not provide. */
export type OrderRow = { [K in keyof PaperTradeRow]: PaperTradeRow[K] };

interface OrdersTableProps {
  filteredOrders: OrderRow[];
  summary: PaperAccountFullSummary | null;
  loading: boolean;
}

export function OrdersTable({ filteredOrders, summary, loading }: OrdersTableProps) {
  const columns = [
    {
      key: "instrument",
      label: "Instrument",
      render: (order: OrderRow) => {
        const sym = order.instrumentSymbol || "NIFTY50";
        const isWin = (order.realizedPnl || 0) >= 0;
        return (
          <div className="font-extrabold text-white">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${isWin ? "bg-emerald-400" : "bg-rose-400"}`}></span>
              <span>{sym}</span>
            </div>
            <span className="block text-[11px] font-mono font-normal text-slate-500 mt-0.5">
              ID: {order.id.substring(0, 8)}...
            </span>
          </div>
        );
      }
    },
    {
      key: "side",
      label: "Side",
      render: (order: OrderRow) => (
        <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-black ${
          order.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
        }`}>
          {order.side}
        </span>
      )
    },
    {
      key: "quantity",
      label: "Qty",
      render: (order: OrderRow) => <span className="font-bold text-slate-200">{formatNumber(order.quantity, 0)}</span>
    },
    {
      key: "entryPrice",
      label: "Entry Price",
      render: (order: OrderRow) => <span className="font-semibold text-slate-300">₹{formatNumber(order.fillPrice, 2)}</span>
    },
    {
      key: "exitPrice",
      label: "Exit Price",
      render: (order: OrderRow) => <span className="font-bold text-white">₹{formatNumber(order.exitPrice || 0, 2)}</span>
    },
    {
      key: "realizedPnl",
      label: "Realized P&L",
      render: (order: OrderRow) => {
        const pnl = order.realizedPnl || 0;
        const isWin = pnl >= 0;
        return (
          <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black ${
            isWin
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm shadow-emerald-500/10"
              : "bg-rose-500/15 text-rose-300 border border-rose-500/30 shadow-sm shadow-rose-500/10"
          }`}>
            {isWin ? "+" : ""}₹{formatNumber(pnl, 2)}
          </span>
        );
      }
    },
    {
      key: "returnPercent",
      label: "Return %",
      render: (order: OrderRow) => {
        const ret = order.returnPercent || 0;
        const isWin = (order.realizedPnl || 0) >= 0;
        return (
          <span className={`font-extrabold ${isWin ? "text-emerald-400" : "text-rose-400"}`}>
            {isWin ? "+" : ""}{ret.toFixed(2)}%
          </span>
        );
      }
    },
    {
      key: "reason",
      label: "AI Exit Trigger / Analysis",
      render: (order: OrderRow) => (
        <div className="text-xs text-slate-300 max-w-xs">
          <div className="truncate font-semibold text-cyan-200">
            {order.exitReason || "Algorithmic Target Reached"}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 max-w-xs truncate">
            {order.notes || `Opened: ${formatTimestamp(order.openedAt)}`}
          </div>
        </div>
      )
    },
    {
      key: "closedAt",
      label: "Closed At",
      render: (order: OrderRow) => (
        <span className="text-xs font-mono text-slate-400">
          {order.closedAt ? formatTimestamp(order.closedAt) : "—"}
        </span>
      )
    }
  ];

  return (
    <GlassPanel className="p-6 border-white/10">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
            <span>📜 Completed Trade Execution Log</span>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-white/10">
              Showing {filteredOrders.length} of {summary?.closedTrades.length || 0}
            </span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Chronological history of all buy and sell orders completed by the AI or manually closed.
          </p>
        </div>
      </div>

      {loading && !summary ? (
        <div className="py-12 text-center text-sm font-semibold text-slate-400">
          <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
          <p>Loading completed order audit log...</p>
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="py-16 text-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8">
          <span className="text-3xl">📜</span>
          <p className="mt-3 text-base font-bold text-white">No Completed Orders Found</p>
          <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
            {summary?.closedTrades.length === 0
              ? "The AI Autonomous Agent hasn't closed any positions yet. Once open positions hit their take-profit (+3.0%) or stop-loss (-1.5%) targets, the completed orders will appear here."
              : "No orders match your selected symbol or outcome filter criteria."}
          </p>
        </div>
      ) : (
        <DataTable columns={columns} data={filteredOrders} />
      )}
    </GlassPanel>
  );
}
