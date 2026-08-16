import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { formatHoldingPeriod, type TradeHistoryRecord } from "../domain";

function currency(value: number | null, fractionDigits = 2): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}₹${formatNumber(value, fractionDigits)}`;
}

function pnlTone(value: number | null): string {
  if (value === null || value === 0) return "text-slate-300";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}

function exitReasonLabel(record: TradeHistoryRecord): string {
  if (record.status === "OPEN") return "Position still open";
  switch (record.exitReason) {
    case "TARGET":
      return "Target reached";
    case "STOP_LOSS":
      return "Stop loss hit";
    case "MANUAL":
      return "Closed manually";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "Not recorded";
  }
}

export function TradeLedgerTable({ records, pageTruncated, pageLimit }: { records: TradeHistoryRecord[], pageTruncated: boolean, pageLimit: number }) {
  return (
    <Reveal delayMs={180}>
      <GlassPanel className="border-white/10 p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold text-white">Chronological trade ledger</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Newest fill first. Every row is a local simulation with no broker or order-routing path.
            </p>
          </div>
          {pageTruncated && (
            <span className="rounded-full border border-amber-300/35 bg-amber-200/10 px-3 py-1 text-xs font-semibold text-amber-100">
              Showing the newest {pageLimit} trades only - raise the row limit to see more
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Instrument</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Entry</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Exit</th>
                <th className="px-4 py-3">Realised P&amp;L</th>
                <th className="px-4 py-3">Return</th>
                <th className="px-4 py-3">Reward</th>
                <th className="px-4 py-3">Held</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm font-medium">
              {records.map((record) => {
                const isOpen = record.status === "OPEN";
                const pnl = record.realizedPnl;
                return (
                  <tr className="transition hover:bg-white/[0.03]" key={record.id}>
                    <td className="px-4 py-4 font-extrabold text-white">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            isOpen ? "bg-cyan-400" : (pnl ?? 0) >= 0 ? "bg-emerald-400" : "bg-rose-400"
                          }`}
                        />
                        {record.instrumentSymbol}
                      </div>
                      <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                        {record.timeframe ?? "timeframe not recorded"}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-300">{record.accountName}</td>
                    {/* CE/PE rather than LONG/SHORT. Every option position is booked LONG because
                        the bot only buys, so the side column rendered a bought call and a bought
                        put identically.

                        A row without a contract still shows its side, because LONG and SHORT do
                        mean something on an index position — but in neutral slate, not the
                        emerald/rose that now carries call-versus-put. Colouring both by the same
                        palette was the ambiguity: a green badge meant "call" on one row and
                        "long" on the next. Every one of the 30 stored trades is an option, so
                        this branch is currently unreachable; it exists so a non-option row would
                        degrade legibly rather than silently reading as a call. */}
                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex rounded-md px-2.5 py-1 text-xs font-black ${
                          record.optionType === "CE"
                            ? "border border-emerald-500/30 bg-emerald-500/20 text-emerald-300"
                            : record.optionType === "PE"
                              ? "border border-rose-500/30 bg-rose-500/20 text-rose-300"
                              : "border border-slate-500/30 bg-slate-500/20 text-slate-300"
                        }`}
                      >
                        {record.optionType ?? record.side}
                      </span>
                      {record.optionStrike !== null && (
                        <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                          {record.underlyingSymbol ?? record.instrumentSymbol} {formatNumber(record.optionStrike, 0)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 font-bold text-slate-200">{formatNumber(record.quantity, 0)}</td>
                    <td className="px-4 py-4 text-slate-300">₹{formatNumber(record.entryPrice, 2)}</td>
                    <td className="px-4 py-4 text-amber-200">
                      {record.targetPrice === null ? "—" : `₹${formatNumber(record.targetPrice, 2)}`}
                      {record.stopLoss !== null && (
                        <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                          SL ₹{formatNumber(record.stopLoss, 2)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 font-bold text-white">
                      {record.exitPrice === null ? "—" : `₹${formatNumber(record.exitPrice, 2)}`}
                    </td>
                    <td className={`px-4 py-4 font-black ${pnlTone(pnl)}`}>{currency(pnl)}</td>
                    <td className={`px-4 py-4 font-bold ${pnlTone(record.returnPercent)}`}>
                      {record.returnPercent === null ? "—" : `${formatNumber(record.returnPercent, 2)}%`}
                    </td>
                    <td className={`px-4 py-4 font-bold ${pnlTone(record.rewardMultiple)}`}>
                      {record.rewardMultiple === null ? "—" : `${formatNumber(record.rewardMultiple, 2)}R`}
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-300">{formatHoldingPeriod(record.holdingMinutes)}</td>
                    <td className="px-4 py-4 text-xs">
                      <span className="font-semibold text-cyan-200">{exitReasonLabel(record)}</span>
                      {record.notes && (
                        <span className="mt-0.5 block max-w-xs truncate text-[11px] text-slate-500">{record.notes}</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-400">{formatTimestamp(record.openedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </Reveal>
  );
}
