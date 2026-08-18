"use client";

import React, { useEffect, useState, memo } from "react";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { formatNseMarketElapsedDuration } from "../domain/nse-market-time";
import { MarketLoader } from "../../../components/ui/market-loader";
import {
  isOptionPaperTrade,
  paperTradeContractLabel,
  type PaperAccountFullSummary,
  type PaperTradeRow,
} from "../../paper-trading/domain";

export interface LiveQuote {
  livePrice: number;
  change: number;
  changePercent: number;
  direction?: "UP" | "DOWN" | "NONE";
}

export type LiveQuoteMap = Record<string, LiveQuote | undefined>;

/** Resolves only the underlying quote. It must never be used as an option premium. */
export function resolveLiveQuote(tradeSymbol?: string, quotes?: LiveQuoteMap): LiveQuote | undefined {
  if (!quotes) return undefined;
  const symbol = (tradeSymbol || "").toUpperCase().replace(/\s+/g, "");
  if (symbol.includes("BANK")) {
    return quotes.BANKNIFTY || quotes["NSE:BANKNIFTY"] || quotes.NIFTYBANK;
  }
  return quotes.NIFTY50 || quotes["NSE:NIFTY50"] || quotes.NIFTY;
}

interface ActivePositionsTableProps {
  summary: PaperAccountFullSummary | null;
  loading: boolean;
  liveQuotes: LiveQuoteMap;
  handleOpenCloseModal: (trade: PaperTradeRow) => void;
}

export const ActivePositionsTable = memo(function ActivePositionsTable({ summary, loading, liveQuotes, handleOpenCloseModal }: ActivePositionsTableProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 10000);
    return () => window.clearInterval(id);
  }, []);

  if (loading && !summary) {
    return (
      <MarketLoader
        className="py-12"
        label="Valuing open positions"
        // Named because this wait has a real cause: each open option is marked against a live
        // quote, and a lapsed Fyers credential turns that into a minutes-long retry rather than
        // a fast failure. A reader who knows that stops wondering whether the page is broken.
        sublabel="Marking each contract against the live book"
      />
    );
  }

  if ((summary?.openTrades.length || 0) === 0) {
    return (
      <div className="py-16 text-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8">
        <span className="text-3xl">📭</span>
        <p className="mt-3 text-base font-bold text-white">No Active Open Positions Right Now</p>
        <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
          New simulated trades from accepted strategy ideas will appear here.
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
            <th className="py-3 px-4">Entry / Premium</th>
            <th className="py-3 px-4">Target / Stop</th>
            <th className="py-3 px-4">Live Mark</th>
            <th
              className="py-3 px-4"
              title="Per contract, at the same volatility the mark used. Theta is shown for the whole position in rupees per day, which is the number the account actually feels."
            >
              Greeks
            </th>
            <th className="py-3 px-4">Live P&amp;L (₹)</th>
            <th className="py-3 px-4">Return %</th>
            <th className="py-3 px-4" title="Counts NSE sessions only: 09:15–15:30 IST, excluding weekends and configured holidays.">Market Time</th>
            <th className="py-3 px-4">AI Strategy / Notes</th>
            <th className="py-3 px-4">Opened At</th>
            <th className="py-3 px-4 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 text-sm font-medium">
          {summary?.openTrades.map((trade) => {
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
            const canClose = currentPrice !== null;

            return (
              <tr key={trade.id} className="hover:bg-white/[0.03] transition">
                <td className="py-4 px-4 font-extrabold text-white">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-cyan-400" />
                    <span>{paperTradeContractLabel(trade)}</span>
                  </div>
                  {isOption && trade.optionExpiry && (
                    <span className="block text-[10px] font-normal text-cyan-300/80 mt-0.5">
                      Exp {new Date(trade.optionExpiry).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                    </span>
                  )}
                  <span className="block text-[11px] font-mono font-normal text-slate-400 mt-0.5">
                    ID: {trade.id.substring(0, 8)}...
                  </span>
                </td>
                {/* CE/PE rather than LONG/SHORT. An option buyer is always LONG, so this column
                    rendered a bought call and a bought put identically.

                    A non-option row keeps its side, in neutral slate rather than the emerald/rose
                    that now means call-versus-put — one palette cannot carry both without a green
                    badge meaning "call" on one row and "long" on the next. */}
                <td className="py-4 px-4">
                  <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-black ${
                    !isOption
                      ? "bg-slate-500/20 text-slate-300 border border-slate-500/30"
                      : trade.optionType === "PE"
                        ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                        : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                  }`}>
                    {isOption ? trade.optionType : trade.side}
                  </span>
                </td>
                <td className="py-4 px-4 font-bold text-slate-200">{formatNumber(trade.quantity, 0)}</td>
                <td className="py-4 px-4 font-semibold text-slate-300">
                  ₹{formatNumber(trade.fillPrice, 2)}
                  {isOption && <span className="block text-[10px] font-normal text-slate-500">option premium</span>}
                </td>
                <td className="py-4 px-4">
                  {targetPrice === null ? <span className="text-slate-500">—</span> : (
                    <div className="flex flex-col gap-0.5">
                      <span className="font-extrabold text-amber-200">₹{formatNumber(targetPrice, 2)}</span>
                      {stopLoss !== null && (
                        <span className="text-[10px] font-mono text-slate-500" title="Stop loss">
                          SL ₹{formatNumber(stopLoss, 2)}
                        </span>
                      )}
                      {isOption && <span className="text-[10px] text-slate-500">premium levels</span>}
                    </div>
                  )}
                </td>
                <td className="py-4 px-4 font-black text-white">
                  {currentPrice === null ? (
                    <span className="inline-flex rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200" title={valuation?.reason || "Live valuation unavailable"}>
                      Unavailable
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1 text-white" title={`Marked ${formatTimestamp(valuation!.asOf)}`}>
                      ₹{formatNumber(currentPrice, 2)}
                      <span className="text-[10px] text-cyan-400 animate-pulse">●</span>
                    </span>
                  )}
                  {isOption && underlyingPrice !== null && (
                    <span className={`block mt-1 text-[10px] font-normal ${direction === "UP" ? "text-emerald-400" : direction === "DOWN" ? "text-rose-400" : "text-slate-500"}`}>
                      Underlying ₹{formatNumber(underlyingPrice, 2)}
                    </span>
                  )}
                  {/*
                    Which of the two marks produced this number. A chain mid is a price the
                    market was quoting; a model mark is this project's estimate of one, and
                    the distinction matters enough to show rather than bury in a tooltip.
                  */}
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
                <td className="py-4 px-4">
                  {/*
                    Greeks exist only for an option marked by the chain or the model, and are
                    computed at whichever volatility that mark used. A spot-marked row has no
                    contract, and showing delta 1 there would imply an option-like exposure
                    the position does not have.
                  */}
                  {greeks === null ? (
                    <span className="text-slate-500" title={valuation?.reason ?? "Not an option position"}>—</span>
                  ) : (
                    <div className="flex flex-col gap-0.5 font-mono text-[11px] leading-tight">
                      <span className="text-emerald-300" title="Delta per contract: premium change per 1 point of underlying">
                        Δ {greeks.delta.toFixed(3)}
                      </span>
                      <span className="text-amber-300" title="Theta for the whole position, in rupees per calendar day. Negative: a buyer pays it.">
                        Θ ₹{formatNumber(greeks.theta * trade.quantity, 0)}/d
                      </span>
                      <span className="text-sky-300" title="Vega per contract, per 1 absolute point of IV">
                        ν {greeks.vega.toFixed(2)}
                      </span>
                      {typeof valuation?.daysToExpiry === "number" && (
                        <span className="text-slate-500" title="Calendar days to expiry — the horizon theta is charged over">
                          {valuation.daysToExpiry.toFixed(1)}d left
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="py-4 px-4">
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
                <td className="py-4 px-4 font-extrabold">
                  {liveReturn === null ? <span className="text-slate-500">—</span> : (
                    <span className={isWinning ? "text-emerald-400" : "text-rose-400"}>
                      {isWinning ? "+" : ""}{liveReturn.toFixed(2)}%
                    </span>
                  )}
                </td>
                <td className="py-4 px-4">
                  <span className="inline-flex rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 font-mono text-xs font-bold text-cyan-200" title={`NSE market time only (09:15–15:30 IST). Opened ${formatTimestamp(trade.openedAt)}`}>
                    {timeInTrade}
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
                    <span title={trade.notes || "Opened via AI Agent"}>{trade.notes || "Opened via AI Agent"}</span>
                  </div>
                </td>
                <td className="py-4 px-4 text-xs font-mono text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                <td className="py-4 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => handleOpenCloseModal(trade)}
                    disabled={!canClose}
                    title={!canClose ? valuation?.reason || "A safe live mark is required before closing." : undefined}
                    className="px-3.5 py-1.5 rounded-xl text-xs font-extrabold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/40 transition disabled:cursor-not-allowed disabled:opacity-40"
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
});
