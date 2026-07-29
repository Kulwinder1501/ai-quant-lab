"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { ResearchShell } from "../../research/components/research-shell";
import type { TradeIdeaRow } from "../domain";

interface PaperAccountOption {
  id: string;
  name: string;
  openingBalance: number;
}

export function StrategyDashboard() {
  const [ideas, setIdeas] = useState<TradeIdeaRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  const [sideFilter, setSideFilter] = useState<string>("ALL");
  const [minConfidence, setMinConfidence] = useState<number>(0);
  const [dateFilter, setDateFilter] = useState<string>("");

  // Generate Modal state
  const [showGenerateModal, setShowGenerateModal] = useState<boolean>(false);
  const [genSymbol, setGenSymbol] = useState<string>("NIFTY50");
  const [genTimeframe, setGenTimeframe] = useState<string>("1d");
  const [generating, setGenerating] = useState<boolean>(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Simulate Trade Modal state
  const [showSimulateModal, setShowSimulateModal] = useState<boolean>(false);
  const [selectedIdea, setSelectedIdea] = useState<TradeIdeaRow | null>(null);
  const [accounts, setAccounts] = useState<PaperAccountOption[]>([]);
  const [simAccountId, setSimAccountId] = useState<string>("");
  const [simQuantity, setSimQuantity] = useState<number>(50);
  const [simNotes, setSimNotes] = useState<string>("Simulated from Strategy Dashboard");
  const [simulating, setSimulating] = useState<boolean>(false);
  const [simSuccess, setSimSuccess] = useState<string | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const fetchIdeas = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const dateParam = dateFilter ? `&date=${dateFilter}` : "";
      const res = await getResearchJson(`/trade-ideas?limit=100&_t=${Date.now()}${dateParam}`, signal) as { data: TradeIdeaRow[] };
      setIdeas(res.data || []);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load trade ideas.");
      }
    } finally {
      setLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    const controller = new AbortController();
    fetchIdeas(controller.signal);
    return () => controller.abort();
  }, [fetchIdeas, dateFilter]);

  const handleGenerateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenerating(true);
    setGenMessage(null);
    setGenError(null);
    try {
      const res = await postResearchJson("/trade-ideas/generate", {
        symbol: genSymbol.trim().toUpperCase(),
        timeframe: genTimeframe,
      }) as {
        data: { strategyVersionId: string; candidatesGenerated: number; tradeIdeaIds: string[]; skippedReason: string | null };
      };
      const count = res.data.candidatesGenerated || 0;
      if (count > 0) {
        setGenMessage(`Successfully generated ${count} breakout proposal(s) for ${genSymbol.toUpperCase()} (${genTimeframe})!`);
      } else {
        setGenMessage(`Evaluated latest candle for ${genSymbol.toUpperCase()} (${genTimeframe}), but rules were not met (${res.data.skippedReason || "NO_CANDIDATE"}).`);
      }
      await fetchIdeas();
    } catch (err: any) {
      setGenError(err.message || "Failed to generate proposals.");
    } finally {
      setGenerating(false);
    }
  };

  const openSimulateModal = async (idea: TradeIdeaRow) => {
    setSelectedIdea(idea);
    setSimQuantity(50);
    setSimNotes(`Simulated ${idea.side} entry on ${idea.instrumentSymbol}`);
    setSimSuccess(null);
    setSimError(null);
    setShowSimulateModal(true);
    try {
      const res = await getResearchJson("/paper-accounts") as { data: PaperAccountOption[] };
      const list = res.data || [];
      setAccounts(list);
      if (list.length > 0) {
        setSimAccountId(list[0].id);
      }
    } catch {
      // ignore
    }
  };

  const handleSimulateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIdea || !simAccountId) return;
    setSimulating(true);
    setSimSuccess(null);
    setSimError(null);
    try {
      await postResearchJson("/paper-trades/open", {
        accountId: simAccountId,
        tradeIdeaId: selectedIdea.id,
        fillPrice: selectedIdea.entryPrice,
        quantity: Number(simQuantity),
        notes: simNotes,
      });
      setSimSuccess(`Successfully simulated ${selectedIdea.side} position for ${selectedIdea.instrumentSymbol} in portfolio!`);
      setTimeout(() => {
        setShowSimulateModal(false);
      }, 1500);
    } catch (err: any) {
      setSimError(err.message || "Failed to open simulated position.");
    } finally {
      setSimulating(false);
    }
  };

  const filteredIdeas = useMemo(() => {
    return ideas.filter((idea) => {
      if (symbolFilter && !idea.instrumentSymbol.toLowerCase().includes(symbolFilter.toLowerCase())) {
        return false;
      }
      if (sideFilter !== "ALL" && idea.side !== sideFilter) {
        return false;
      }
      if (minConfidence > 0 && idea.confidence < minConfidence) {
        return false;
      }
      return true;
    });
  }, [ideas, symbolFilter, sideFilter, minConfidence]);

  return (
    <ResearchShell
      activeView="strategy"
      eyebrow="Quantitative Proposals"
      title="Strategy Engine & Trade Ideas"
      description="Generate and evaluate quantitative breakout proposals from historical market context. Filter by side, confidence, and instrument."
      connectionLabel="Engine Ready"
    >
      <div className="space-y-6">
        {/* Control Bar & Filters */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <label htmlFor="filter-sym" className="text-xs font-semibold text-slate-400">
                  Symbol:
                </label>
                <select
                  id="filter-sym"
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="bg-transparent text-sm font-semibold text-white focus:outline-none w-auto cursor-pointer"
                >
                  <option value="" className="bg-slate-900 text-white">All Symbols</option>
                  <option value="NIFTY50" className="bg-slate-900 text-white">NIFTY 50</option>
                  <option value="BANKNIFTY" className="bg-slate-900 text-white">NIFTY BANK</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <label htmlFor="filter-side" className="text-xs font-semibold text-slate-400">
                  Side:
                </label>
                <select
                  id="filter-side"
                  value={sideFilter}
                  onChange={(e) => setSideFilter(e.target.value)}
                  className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer"
                >
                  <option value="ALL" className="bg-slate-900 text-white">All Sides</option>
                  <option value="BUY" className="bg-slate-900 text-emerald-300">BUY / Long</option>
                  <option value="SELL" className="bg-slate-900 text-rose-300">SELL / Short</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <label htmlFor="filter-conf" className="text-xs font-semibold text-slate-400">
                  Min Conf:
                </label>
                <select
                  id="filter-conf"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(Number(e.target.value))}
                  className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer"
                >
                  <option value={0} className="bg-slate-900 text-white">Any (0%)</option>
                  <option value={0.5} className="bg-slate-900 text-white">&ge; 50%</option>
                  <option value={0.65} className="bg-slate-900 text-white">&ge; 65%</option>
                  <option value={0.8} className="bg-slate-900 text-white">&ge; 80%</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <label htmlFor="filter-date" className="text-xs font-semibold text-slate-400">
                  Date:
                </label>
                <input
                  id="filter-date"
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="bg-transparent text-sm font-semibold text-white focus:outline-none w-auto cursor-pointer placeholder:text-slate-600"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fetchIdeas()}
                disabled={loading}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 transition"
              >
                🔄 Refresh
              </button>

              <button
                type="button"
                onClick={() => { setShowGenerateModal(true); setGenMessage(null); setGenError(null); }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-md shadow-cyan-500/20 flex items-center gap-1.5"
              >
                <span>⚡ Generate Proposals</span>
              </button>
            </div>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm">
            {error}
          </div>
        )}

        {/* Proposals Grid / Table */}
        <Reveal delayMs={100}>
          <GlassPanel className="p-6 border-white/10">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-white">Quantitative Breakout Proposals ({filteredIdeas.length})</h2>
                <p className="text-xs text-slate-400">Generated from Trend Breakout and Candlestick Pattern engines. These are research proposals, not automated orders.</p>
              </div>
            </div>

            {loading && ideas.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400">Loading strategy proposals from database...</div>
            ) : filteredIdeas.length === 0 ? (
              <div className="py-12 text-center rounded-xl border border-dashed border-white/10 bg-white/5">
                <p className="text-sm font-semibold text-slate-300">No matching proposals found</p>
                <p className="text-xs text-slate-500 mt-1">Try adjusting your filters or click &quot;Generate Proposals&quot; to evaluate recent candles.</p>
              </div>
            ) : (
              <div className="max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredIdeas.map((idea) => {
                    const isBuy = idea.side === "BUY";
                    const rr = idea.riskReward || 0;
                    return (
                      <div
                        key={idea.id}
                        className="rounded-2xl border border-white/10 bg-slate-950/60 p-5 hover:border-cyan-500/30 transition flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <span className="text-xs font-mono font-semibold text-slate-400">
                                {idea.candleTimeframe || "1d"} • {formatTimestamp(idea.candleCloseTime || null)}
                              </span>
                              <h3 className="text-lg font-extrabold text-white mt-0.5">{idea.instrumentSymbol}</h3>
                              <p className="text-xs text-slate-400 truncate max-w-[180px]">{idea.instrumentName}</p>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-extrabold tracking-wide ${
                                isBuy ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                              }`}>
                                {idea.side}
                              </span>
                              <span className="text-xs font-semibold text-cyan-300">
                                Conf: {formatPercentage(idea.confidence)}
                              </span>
                            </div>
                          </div>

                          <div className="mt-4 grid grid-cols-3 gap-2 py-3 px-3.5 rounded-xl bg-slate-900/80 border border-white/5 text-center">
                            <div>
                              <span className="block text-[10px] uppercase font-semibold text-slate-500">Entry</span>
                              <span className="text-sm font-bold text-white">₹{formatNumber(idea.entryPrice, 2)}</span>
                            </div>
                            <div>
                              <span className="block text-[10px] uppercase font-semibold text-slate-500">Target</span>
                              <span className="text-sm font-bold text-emerald-400">₹{formatNumber(idea.targetPrice, 2)}</span>
                            </div>
                            <div>
                              <span className="block text-[10px] uppercase font-semibold text-slate-500">Stop Loss</span>
                              <span className="text-sm font-bold text-rose-400">₹{formatNumber(idea.stopLoss, 2)}</span>
                            </div>
                          </div>

                          <div className="mt-3 flex items-center justify-between text-xs text-slate-400 px-1">
                            <span>Risk : Reward Ratio</span>
                            <span className="font-bold text-amber-300">1 : {formatNumber(rr, 2)}</span>
                          </div>

                          {Array.isArray(idea.reasoning) && idea.reasoning.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-white/10 space-y-1">
                              <span className="text-[10px] uppercase font-semibold tracking-wider text-slate-500">Rule Evaluation Notes</span>
                              <ul className="text-xs text-slate-300 space-y-1 max-h-24 overflow-y-auto pr-1">
                                {idea.reasoning.slice(0, 3).map((r: any, idx: number) => (
                                  <li key={idx} className="flex items-center gap-1.5">
                                    <span className={r.passed ? "text-emerald-400 font-bold" : "text-slate-500"}>{r.passed ? "✓" : "•"}</span>
                                    <span className="truncate">{r.rule || JSON.stringify(r)}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between">
                          <span className="text-[10px] font-mono text-slate-500 truncate max-w-[120px]">
                            ID: {idea.id.slice(0, 8)}...
                          </span>
                          <button
                            type="button"
                            onClick={() => openSimulateModal(idea)}
                            className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 transition shadow-sm"
                          >
                            🚀 Simulate in Portfolio
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </GlassPanel>
        </Reveal>

        {/* Modal: Generate Proposals */}
        {showGenerateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-md max-h-[90vh] overflow-y-auto p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Generate Breakout Proposals</h3>
              <p className="text-xs text-slate-400 mt-1">
                Evaluate the latest completed market candles against the Trend Breakout strategy rules.
              </p>

              {genMessage && <p className="mt-3 text-xs text-cyan-300 bg-cyan-500/10 p-2.5 rounded-xl border border-cyan-500/20 font-medium">{genMessage}</p>}
              {genError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{genError}</p>}

              <form onSubmit={handleGenerateSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Instrument Symbol</label>
                  <select
                    value={genSymbol}
                    onChange={(e) => setGenSymbol(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 font-bold"
                  >
                    <option value="NIFTY50">⚡ NIFTY 50 (NIFTY50)</option>
                    <option value="BANKNIFTY">⚡ NIFTY BANK (BANKNIFTY)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Timeframe</label>
                  <select
                    value={genTimeframe}
                    onChange={(e) => setGenTimeframe(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  >
                    <option value="15m">15 Minutes (15m)</option>
                    <option value="1h">1 Hour (1h)</option>
                    <option value="1d">Daily (1d)</option>
                    <option value="1w">Weekly (1w)</option>
                  </select>
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowGenerateModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={generating}
                    className="px-5 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
                  >
                    {generating ? (
                      <>
                        <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Evaluating...</span>
                      </>
                    ) : (
                      <span>⚡ Run Evaluation</span>
                    )}
                  </button>
                </div>
              </form>
            </GlassPanel>
          </div>
        )}

        {/* Modal: Simulate Trade in Portfolio */}
        {showSimulateModal && selectedIdea && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-md max-h-[90vh] overflow-y-auto p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Simulate in Paper Portfolio</h3>
              <p className="text-xs text-slate-400 mt-1">
                Execute a simulated {selectedIdea.side} order for {selectedIdea.instrumentSymbol} at ₹{formatNumber(selectedIdea.entryPrice, 2)}.
              </p>

              {simSuccess && <p className="mt-3 text-xs text-emerald-300 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 font-bold">{simSuccess}</p>}
              {simError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{simError}</p>}

              <form onSubmit={handleSimulateSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Target Paper Portfolio</label>
                  {accounts.length === 0 ? (
                    <div className="mt-1 p-3 rounded-xl bg-slate-900 border border-white/10 text-xs text-rose-300">
                      No paper trading portfolios found. Please create one in the Paper Trading tab first!
                    </div>
                  ) : (
                    <select
                      value={simAccountId}
                      onChange={(e) => setSimAccountId(e.target.value)}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    >
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} (Balance: ₹{formatNumber(acc.openingBalance, 0)})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Quantity (Shares / Lots)</label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="1"
                    value={simQuantity}
                    onChange={(e) => setSimQuantity(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Simulation Notes</label>
                  <input
                    type="text"
                    value={simNotes}
                    onChange={(e) => setSimNotes(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowSimulateModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={simulating || accounts.length === 0}
                    className="px-5 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
                  >
                    {simulating ? (
                      <>
                        <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Simulating...</span>
                      </>
                    ) : (
                      <span>🚀 Confirm Order</span>
                    )}
                  </button>
                </div>
              </form>
            </GlassPanel>
          </div>
        )}
      </div>
    </ResearchShell>
  );
}
