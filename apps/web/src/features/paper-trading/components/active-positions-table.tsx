"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import {
  resolveLiveQuote,
  type LiveQuoteMap,
} from "../../positions/components/active-positions-table";
import { formatNseMarketElapsedDuration } from "../../positions/domain/nse-market-time";
import { isOptionPaperTrade, paperTradeContractLabel, type PaperTradeRow } from "../domain";

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
  liveQuotes: LiveQuoteMap;
  isStreaming?: boolean;
  onCloseTrade: (trade: PaperTradeRow) => void;
  onRefresh?: () => void;
}

export function ActivePositionsTable({
  openTrades,
  pendingTrades,
  loading,
  liveQuotes,
  isStreaming = false,
  onCloseTrade,
  onRefresh,
}: ActivePositionsTableProps) {
  const activeTrades = [...pendingTrades, ...openTrades];
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <GlassPanel className="p-6 border-white/10">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
            <span>Active Simulated Positions ({activeTrades.length})</span>
            {isStreaming && (
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse">
                ● Live SSE Ticking
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-400">
            Live marks and P&amp;L refresh on the same cadence as Portfolio Positions (summary poll + underlying ticks).
          </p>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 border border-white/10 transition"
          >
            🔄 Refresh Positions
          </button>
        )}
      </div>

      {loading && activeTrades.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400">Valuing open positions against the live book...</div>
      ) : activeTrades.length === 0 ? (
        <div className="py-10 text-center rounded-xl border border-dashed border-white/10 bg-white/5">
          <p className="text-sm font-semibold text-slate-300">No active simulated trades</p>
          <p className="text-xs text-slate-500 mt-1">
            Click &quot;Manual Trade&quot; above to buy a contract from the live chain, or &quot;From AI Proposal&quot; to open one from a strategy idea.
          </p>
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
                <th className="py-3 px-4">Entry / Premium</th>
                <th className="py-3 px-4">Target / Stop</th>
                <th className="py-3 px-4">Live Mark</th>
                <th className="py-3 px-4" title="Per contract, at the same volatility the mark used. Theta is for the whole position in rupees per day.">
                  Greeks
                </th>
                <th className="py-3 px-4">Live P&amp;L (₹)</th>
                <th className="py-3 px-4">Return %</th>
                <th className="py-3 px-4" title="Counts NSE sessions only: 09:15–15:30 IST, excluding weekends and configured holidays.">
                  Market Time
                </th>
                <th className="py-3 px-4">Opened At</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm">
              {activeTrades.map((trade) => {
                const symbol = trade.underlyingSymbol || trade.instrumentSymbol || "NIFTY50";
                const quote = resolveLiveQuote(symbol, liveQuotes);
                const valuation = trade.liveValuation;
                const currentPrice = valuation?.status === "AVAILABLE" ? valuation.markPrice : null;
                const underlyingPrice = valuation?.underlyingPrice ?? quote?.livePrice ?? null;
                const direction = quote?.direction || "NONE";
                const isOption = isOptionPaperTrade(trade);
                const greeks = valuation?.status === "AVAILABLE" ? valuation.greeks : null;
                const livePnl = valuation?.status === "AVAILABLE" ? valuation.unrealizedPnl : null;
                const liveReturn = valuation?.status === "AVAILABLE" ? valuation.returnPercent : null;
                const isWinning = livePnl !== null && livePnl >= 0;
                const targetPrice = typeof trade.targetPrice === "number" ? trade.targetPrice : null;
                const stopLoss = typeof trade.stopLoss === "number" ? trade.stopLoss : null;
                const timeInTrade = formatNseMarketElapsedDuration(trade.openedAt, nowMs);
                const canClose = currentPrice !== null && trade.status !== "PENDING";

                return (
                  <tr key={trade.id} className="hover:bg-white/[0.02] transition">
                    <td className="py-3.5 px-4 font-bold text-white">
                      {paperTradeContractLabel(trade)}
                      {isOption && trade.optionExpiry && (
                        <span className="block text-[10px] font-normal text-cyan-300/80 mt-0.5">
                          Exp {new Date(trade.optionExpiry).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      )}
                      <span className="block text-xs font-normal text-slate-500">{trade.timeframe || "1d"}</span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                        trade.status === "PENDING"
                          ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                          : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                      }`}>
                        {trade.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                        !isOption
                          ? "bg-slate-500/20 text-slate-300 border border-slate-500/30"
                          : trade.optionType === "PE"
                            ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      }`}>
                        {isOption ? (trade.optionType ?? trade.side) : trade.side}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-medium text-slate-200">
                      {formatLots(trade.quantity, trade.instrumentSymbol)}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-white">
                      ₹{formatNumber(trade.fillPrice, 2)}
                      {isOption && <span className="block text-[10px] font-normal text-slate-500">option premium</span>}
                    </td>
                    <td className="py-3.5 px-4">
                      {targetPrice === null ? <span className="text-slate-500">—</span> : (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-extrabold text-amber-200">₹{formatNumber(targetPrice, 2)}</span>
                          {stopLoss !== null && (
                            <span className="text-[10px] font-mono text-slate-500" title="Stop loss">
                              SL ₹{formatNumber(stopLoss, 2)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-white">
                      {currentPrice === null ? (
                        <span className="text-amber-300" title={valuation?.reason || "Live valuation unavailable"}>Unavailable</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5" title={valuation?.asOf ? `Marked ${formatTimestamp(valuation.asOf)}` : undefined}>
                          ₹{formatNumber(currentPrice, 2)}
                          <span className="text-[10px] text-cyan-400 animate-pulse">●</span>
                        </span>
                      )}
                      {isOption && underlyingPrice !== null && (
                        <span className={`block mt-1 text-[10px] font-normal ${
                          direction === "UP" ? "text-emerald-400" : direction === "DOWN" ? "text-rose-400" : "text-slate-500"
                        }`}>
                          Underlying ₹{formatNumber(underlyingPrice, 2)}
                        </span>
                      )}
                      {isOption && currentPrice !== null && (
                        <span
                          className={`block mt-0.5 text-[10px] font-normal ${
                            valuation?.source === "OPTION_CHAIN_MID" ? "text-violet-300" : "text-slate-500"
                          }`}
                          title={
                            valuation?.source === "OPTION_CHAIN_MID"
                              ? "Marked at the mid of the observed option chain, with IV solved from that mid."
                              : "No stored chain snapshot covers this contract, so the mark is the Black-Scholes model's."
                          }
                        >
                          {valuation?.source === "OPTION_CHAIN_MID" ? "chain mid" : "model mark"}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      {greeks === null ? (
                        <span className="text-slate-500">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5 font-mono text-[11px] leading-tight">
                          <span className="text-emerald-300" title="Delta per contract">
                            Δ {greeks.delta.toFixed(3)}
                          </span>
                          <span className="text-amber-300" title="Theta for the whole position, rupees per calendar day">
                            Θ ₹{formatNumber(greeks.theta * trade.quantity, 0)}/d
                          </span>
                          <span className="text-sky-300" title="Vega per contract, per 1 absolute point of IV">
                            ν {greeks.vega.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      {livePnl === null ? <span className="text-slate-500">—</span> : (
                        <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black ${
                          isWinning
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                        }`}>
                          {isWinning ? "+" : ""}₹{formatNumber(livePnl, 2)}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-extrabold">
                      {liveReturn === null ? <span className="text-slate-500">—</span> : (
                        <span className={isWinning ? "text-emerald-400" : "text-rose-400"}>
                          {isWinning ? "+" : ""}{liveReturn.toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className="inline-flex rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 font-mono text-xs font-bold text-cyan-200"
                        title={`NSE market time only (09:15–15:30 IST). Opened ${formatTimestamp(trade.openedAt)}`}
                      >
                        {timeInTrade}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onCloseTrade(trade)}
                        disabled={!canClose}
                        title={!canClose ? (valuation?.reason || "A safe live mark is required before closing.") : undefined}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/30 transition disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Close Position
                      </button>
                    </td>
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
