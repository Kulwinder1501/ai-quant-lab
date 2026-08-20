import { formatNumber } from "../../research/presentation";
import { GlassPanel } from "../../../components/ui/glass-panel";
import type { PaperAccountSummary } from "../../paper-trading/domain";

interface OrdersFilterBarProps {
  accounts: PaperAccountSummary[];
  selectedAccountId: string;
  setSelectedAccountId: (id: string) => void;
  filterDate: string;
  setFilterDate: (val: string) => void;
  filterSymbol: string;
  setFilterSymbol: (val: string) => void;
  filterSide: string;
  setFilterSide: (val: string) => void;
  filterOutcome: string;
  setFilterOutcome: (val: string) => void;
  onRefresh: () => void;
}

export function OrdersFilterBar({
  accounts,
  selectedAccountId,
  setSelectedAccountId,
  filterDate,
  setFilterDate,
  filterSymbol,
  setFilterSymbol,
  filterSide,
  setFilterSide,
  filterOutcome,
  setFilterOutcome,
  onRefresh,
}: OrdersFilterBarProps) {
  return (
    <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-3 w-3 rounded-full bg-cyan-400 animate-pulse" />
        <label htmlFor="ord-acc-select" className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Trading Account:
        </label>
        <select
          id="ord-acc-select"
          value={selectedAccountId}
          onChange={(e) => setSelectedAccountId(e.target.value)}
          className="bg-slate-950 text-sm font-extrabold text-white px-3 py-1.5 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500 cursor-pointer"
        >
          {accounts.map((acc) => (
            <option key={acc.id} value={acc.id} className="bg-slate-900 text-white">
              {acc.name} (₹{formatNumber(acc.openingBalance, 0)})
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Date Filter */}
        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <span className="text-xs font-semibold text-slate-400">Date:</span>
          <input
            type="date"
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
            className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer [color-scheme:dark]"
          />
          {filterDate && (
            <button
              type="button"
              onClick={() => setFilterDate("")}
              className="text-xs font-bold text-slate-400 hover:text-white"
              title="Clear date"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <span className="text-xs font-semibold text-slate-400">Symbol:</span>
          <select
            value={filterSymbol}
            onChange={(e) => setFilterSymbol(e.target.value)}
            className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
          >
            <option value="ALL" className="bg-slate-900 text-white">All Symbols</option>
            <option value="NIFTY50" className="bg-slate-900 text-white">NIFTY 50</option>
            <option value="BANKNIFTY" className="bg-slate-900 text-white">BANK NIFTY</option>
          </select>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <span className="text-xs font-semibold text-slate-400">Side:</span>
          <select
            value={filterSide}
            onChange={(e) => setFilterSide(e.target.value)}
            className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
          >
            <option value="ALL" className="bg-slate-900 text-white">Buy &amp; Sell</option>
            <option value="BUY" className="bg-slate-900 text-white">BUY Only</option>
            <option value="SELL" className="bg-slate-900 text-white">SELL Only</option>
          </select>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
          <span className="text-xs font-semibold text-slate-400">Outcome:</span>
          <select
            value={filterOutcome}
            onChange={(e) => setFilterOutcome(e.target.value)}
            className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
          >
            <option value="ALL" className="bg-slate-900 text-white">All Trades</option>
            <option value="WIN" className="bg-slate-900 text-white">✅ Winners</option>
            <option value="LOSS" className="bg-slate-900 text-white">❌ Losers</option>
          </select>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 border border-white/10 transition"
        >
          🔄 Refresh
        </button>
      </div>
    </GlassPanel>
  );
}
