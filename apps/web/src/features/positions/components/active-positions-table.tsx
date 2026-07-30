import React from "react";
import { formatNumber, formatTimestamp } from "../../research/presentation";

// Need to match quote resolve from parent if we just pass quotes down or do it here. 
// Parent resolves it, let's pass a helper or just the quotes.

export function resolveLiveQuote(tradeSymbol?: string, quotes?: any) {
  if (!quotes) return undefined;
  const s = (tradeSymbol || "").toUpperCase().replace(/\s+/g, "");
  if (s.includes("BANK")) {
    return quotes["BANKNIFTY"] || quotes["NSE:BANKNIFTY"] || quotes["NIFTYBANK"];
  }
  return quotes["NIFTY50"] || quotes["NSE:NIFTY50"] || quotes["NIFTY"];
}

interface ActivePositionsTableProps {
  summary: any;
  loading: boolean;
  liveQuotes: any;
  handleOpenCloseModal: (trade: any) => void;
}

export function ActivePositionsTable({ summary, loading, liveQuotes, handleOpenCloseModal }: ActivePositionsTableProps) {
  if (loading && !summary) {
    return (
      <div className="py-12 text-center text-sm font-semibold text-slate-400">
        <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
        <p>Loading open positions and calculating live valuations...</p>
      </div>
    );
  }

  if ((summary?.openTrades.length || 0) === 0) {
    return (
      <div className="py-16 text-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8">
        <span className="text-3xl">📭</span>
        <p className="mt-3 text-base font-bold text-white">No Active Open Positions Right Now</p>
        <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
          The AI Autonomous Agent is scanning NIFTY 50 and BANK NIFTY for high-confidence multi-modal setups (≥80% confidence). When a trade is triggered, it will appear here instantly.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-slate-400">
            <th className="py-3 px-4">Instrument</th>
            <th className="py-3 px-4">Side</th>
            <th className="py-3 px-4">Qty</th>
            <th className="py-3 px-4">Entry Price</th>
            <th className="py-3 px-4">Live Price</th>
            <th className="py-3 px-4">Live P&amp;L (₹)</th>
            <th className="py-3 px-4">Return %</th>
            <th className="py-3 px-4">AI Strategy / Notes</th>
            <th className="py-3 px-4">Opened At</th>
            <th className="py-3 px-4 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 text-sm font-medium">
          {summary?.openTrades.map((trade: any) => {
            const sym = trade.instrumentSymbol || "NIFTY50";
            const quote = resolveLiveQuote(sym, liveQuotes);
            const currentPrice = quote?.livePrice || trade.fillPrice;
            const direction = quote?.direction || "NONE";
            const isBuy = trade.side === "BUY";
            const priceDiff = isBuy ? currentPrice - trade.fillPrice : trade.fillPrice - currentPrice;
            const livePnl = priceDiff * trade.quantity;
            const liveRet = ((livePnl / (trade.fillPrice * trade.quantity)) * 100);
            const isWinning = livePnl >= 0;

            return (
              <tr key={trade.id} className="hover:bg-white/[0.03] transition">
                <td className="py-4 px-4 font-extrabold text-white">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-cyan-400"></span>
                    <span>{sym}</span>
                  </div>
                  <span className="block text-[11px] font-mono font-normal text-slate-400 mt-0.5">
                    ID: {trade.id.substring(0, 8)}...
                  </span>
                </td>
                <td className="py-4 px-4">
                  <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-black ${
                    isBuy ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  }`}>
                    {trade.side}
                  </span>
                </td>
                <td className="py-4 px-4 font-bold text-slate-200">{formatNumber(trade.quantity, 0)}</td>
                <td className="py-4 px-4 font-semibold text-slate-300">₹{formatNumber(trade.fillPrice, 2)}</td>
                <td className="py-4 px-4 font-black text-white">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors duration-300 ${
                    direction === "UP" ? "bg-emerald-500/25 text-emerald-200 border border-emerald-500/40 shadow-sm shadow-emerald-500/10" :
                    direction === "DOWN" ? "bg-rose-500/25 text-rose-200 border border-rose-500/40 shadow-sm shadow-rose-500/10" :
                    "bg-slate-900 text-white border border-white/10"
                  }`}>
                    ₹{formatNumber(currentPrice, 2)}
                    <span className={`text-[10px] ${direction === "UP" ? "text-emerald-400 animate-bounce" : direction === "DOWN" ? "text-rose-400 animate-bounce" : "text-cyan-400 animate-pulse"}`}>
                      {direction === "UP" ? "▲" : direction === "DOWN" ? "▼" : "●"}
                    </span>
                  </span>
                </td>
                <td className="py-4 px-4">
                  <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black transition-colors duration-300 ${
                    isWinning
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/10"
                      : "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm shadow-rose-500/10"
                  }`}>
                    {isWinning ? "+" : ""}₹{formatNumber(livePnl, 2)}
                  </span>
                </td>
                <td className="py-4 px-4 font-extrabold">
                  <span className={`transition-colors duration-300 ${isWinning ? "text-emerald-400" : "text-rose-400"}`}>
                    {isWinning ? "+" : ""}{liveRet.toFixed(2)}%
                  </span>
                </td>
                <td className="py-4 px-4 max-w-[200px] truncate text-slate-400 text-xs">
                  <div className="flex flex-col gap-1">
                    <span className={`inline-flex self-start px-2 py-0.5 rounded text-[10px] font-bold ${
                      trade.timeframe === "1m" 
                        ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" 
                        : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                    }`}>
                      {trade.timeframe === "1m" ? "momentum-scalp" : "trend-breakout"}
                    </span>
                    <span title={trade.notes || "Opened via AI Agent"}>
                      {trade.notes || "Opened via AI Agent"}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-4 text-xs font-mono text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                <td className="py-4 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => handleOpenCloseModal(trade)}
                    className="px-3.5 py-1.5 rounded-xl text-xs font-extrabold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/40 transition shadow-sm shadow-rose-500/10"
                  >
                    ⚡ Close Trade
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
