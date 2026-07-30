"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { PageHeader } from "../../../components/layout/page-header";
import type { TradeIdeaRow } from "../domain";
import { StrategyFilters } from "./strategy-filters";
import { ProposalsGrid } from "./proposals-grid";
import { GenerateProposalsModal } from "./generate-proposals-modal";
import { SimulateTradeModal } from "./simulate-trade-modal";

export interface PaperAccountOption {
  id: string;
  name: string;
  openingBalance: number;
}

export function StrategyDashboard({ strategyKey, isScalp }: { strategyKey?: string, isScalp?: boolean } = {}) {
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
  const [genTimeframe, setGenTimeframe] = useState<string>(isScalp ? "1m" : "1d");
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
      const dateParam = dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : "";
      // The strategy filter has to go to the API. Filtering the response here instead
      // applies limit=100 across every strategy first, so whichever strategy was
      // regenerated last fills the page and this one shows stale rows or nothing.
      const strategyParam = strategyKey ? `&strategy=${encodeURIComponent(strategyKey)}` : "";
      const res = await getResearchJson(
        `/trade-ideas?limit=100&_t=${Date.now()}${dateParam}${strategyParam}`,
        signal,
      ) as { data: TradeIdeaRow[] };
      setIdeas(res.data || []);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load trade ideas.");
      }
    } finally {
      setLoading(false);
    }
  }, [dateFilter, strategyKey]);

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
        data: { strategyVersionId: string; candidatesGenerated: number; tradeIdeaIds: string[]; skippedReason: string | null }[];
      };
      
      // If we got an array, check if any succeeded
      let totalGen = 0;
      let reasons: string[] = [];
      if (Array.isArray(res.data)) {
        for (const item of res.data) {
          if (item.candidatesGenerated > 0) totalGen += item.candidatesGenerated;
          else if (item.skippedReason) reasons.push(item.skippedReason);
        }
      }

      if (totalGen > 0) {
        setGenMessage(`Successfully generated ${totalGen} proposal(s) for ${genSymbol.toUpperCase()} (${genTimeframe})!`);
      } else {
        setGenMessage(`Evaluated latest candle for ${genSymbol.toUpperCase()} (${genTimeframe}), but rules were not met (${reasons.length > 0 ? reasons[0] : "NO_CANDIDATE"}).`);
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
    <>
      <PageHeader
        eyebrow="Quantitative Proposals"
        title={isScalp ? "Scalp Strategy & Ideas" : "Strategy Engine & Trade Ideas"}
        description="Generate and evaluate quantitative breakout proposals from historical market context. Filter by side, confidence, and instrument."
      >
      </PageHeader>
      <div className="space-y-6">
        {/* Control Bar & Filters */}
        <Reveal>
          <StrategyFilters
            symbolFilter={symbolFilter}
            setSymbolFilter={setSymbolFilter}
            sideFilter={sideFilter}
            setSideFilter={setSideFilter}
            minConfidence={minConfidence}
            setMinConfidence={setMinConfidence}
            dateFilter={dateFilter}
            setDateFilter={setDateFilter}
            loading={loading}
            onRefresh={() => fetchIdeas()}
            onGenerate={() => { setShowGenerateModal(true); setGenMessage(null); setGenError(null); }}
          />
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

            <ProposalsGrid 
              filteredIdeas={filteredIdeas}
              loading={loading}
              ideasLength={ideas.length}
              openSimulateModal={openSimulateModal}
            />
          </GlassPanel>
        </Reveal>

        {/* Modal: Generate Proposals */}
        <GenerateProposalsModal 
          show={showGenerateModal}
          onClose={() => setShowGenerateModal(false)}
          genSymbol={genSymbol}
          setGenSymbol={setGenSymbol}
          genTimeframe={genTimeframe}
          setGenTimeframe={setGenTimeframe}
          isScalp={!!isScalp}
          generating={generating}
          genMessage={genMessage}
          genError={genError}
          onSubmit={handleGenerateSubmit}
        />

        {/* Modal: Simulate Trade in Portfolio */}
        <SimulateTradeModal 
          show={showSimulateModal}
          onClose={() => setShowSimulateModal(false)}
          selectedIdea={selectedIdea}
          accounts={accounts}
          simAccountId={simAccountId}
          setSimAccountId={setSimAccountId}
          simQuantity={simQuantity}
          setSimQuantity={setSimQuantity}
          simNotes={simNotes}
          setSimNotes={setSimNotes}
          simulating={simulating}
          simSuccess={simSuccess}
          simError={simError}
          onSubmit={handleSimulateSubmit}
        />
      </div>
    </>
  );
}
