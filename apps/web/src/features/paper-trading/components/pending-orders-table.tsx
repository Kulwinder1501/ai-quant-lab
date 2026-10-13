import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { limitOrderInfo, paperTradeContractLabel, type PaperTradeRow } from "../domain";

interface PendingOrdersTableProps {
  orders: PaperTradeRow[];
  /** The order whose cancel is in flight, so its button can say so. */
  cancellingId: string | null;
  onCancel: (order: PaperTradeRow) => void;
}

/**
 * Limit orders that have not filled yet.
 *
 * Nothing here is a position: no money is committed until the ask comes down to the limit. The exit sweep fills an
 * order the moment it does, and cancels it at its valid-until time or the 3:30 pm close, so a row leaves this list
 * by becoming a position, lapsing, or being cancelled by hand.
 */
export function PendingOrdersTable({ orders, cancellingId, onCancel }: PendingOrdersTableProps) {
  if (orders.length === 0) return null;

  return (
    <GlassPanel className="p-6 border-amber-400/20">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-white">Working Orders ({orders.length})</h2>
        <p className="text-xs text-slate-400">
          Limit orders waiting for the price. They buy only if the ask falls to the limit, and lapse if it never does.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <th className="py-3 px-4">Contract</th>
              <th className="py-3 px-4">Limit</th>
              <th className="py-3 px-4">Ask when placed</th>
              <th className="py-3 px-4">Qty</th>
              <th className="py-3 px-4">Target / Stop</th>
              <th className="py-3 px-4">Valid until</th>
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-sm">
            {orders.map((order) => {
              const info = limitOrderInfo(order);
              return (
                <tr key={order.id}>
                  <td className="py-3.5 px-4 font-bold text-white">
                    {paperTradeContractLabel(order)}
                    <span className="block text-xs font-normal text-slate-500">
                      {order.optionExpiry ? `Exp ${order.optionExpiry.slice(0, 10)}` : ""}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-semibold text-amber-300">₹{formatNumber(info?.limitPrice ?? order.fillPrice, 2)}</td>
                  <td className="py-3.5 px-4 text-slate-300">{info && info.placedAsk > 0 ? `₹${formatNumber(info.placedAsk, 2)}` : "—"}</td>
                  <td className="py-3.5 px-4 text-slate-200">{formatNumber(order.quantity, 0)} units</td>
                  <td className="py-3.5 px-4 text-xs">
                    <span className="text-emerald-300">₹{formatNumber(order.targetPrice ?? 0, 2)}</span>
                    <span className="mx-1 text-slate-600">/</span>
                    <span className="text-rose-300">₹{formatNumber(order.stopLoss ?? 0, 2)}</span>
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-300">{info ? formatTimestamp(info.validUntil) : "End of day"}</td>
                  <td className="py-3.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => onCancel(order)}
                      disabled={cancellingId === order.id}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/30 transition disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {cancellingId === order.id ? "Cancelling…" : "Cancel"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
