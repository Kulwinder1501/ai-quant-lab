"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Timer, TrendingUp } from "lucide-react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { Tabs } from "../../../components/ui/tabs";
import { getResearchJson, postResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";
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

export type StrategyMode = "swing" | "scalp";

const modeConfig: Record<StrategyMode, {
  strategyKey: string;
  defaultTimeframe: string;
  title: string;
  gridHeading: string;
  gridDescription: string;
}> = {
  swing: {
    strategyKey: "trend-breakout",
    defaultTimeframe: "1d",
    title: "Strategy Engine & Trade Ideas",
    gridHeading: "Quantitative Breakout Proposals",
    gridDescription: "Generated from Trend Breakout and Candlestick Pattern engines. These are research proposals, not automated orders.",
  },
  scalp: {
    strategyKey: "momentum-scalp",
    defaultTimeframe: "1m",
    title: "Scalp Strategy & Ideas",
    gridHeading: "Momentum Scalp Proposals",
    gridDescription: "Generated from the 1m Momentum Scalp engine (EMA separation, VWAP displacement, bounded RSI). These are research proposals, not automated orders.",
  },
};

export function StrategyDashboard({ initialMode = "swing" }: { initialMode?: StrategyMode } = {}) {
  const [mode, setMode] = useState<StrategyMode>(initialMode);
  const { strategyKey, title, gridHeading, gridDescription } = modeConfig[mode];
  const isScalp = mode === "scalp";

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
  const [genTimeframe, setGenTimeframe] = useState<string>(modeConfig[initialMode].defaultTimeframe);
  const [generating, setGenerating] = useState<boolean>(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Simulate Trade Modal state
  const [showSimulateModal, setShowSimulateModal] = useState<boolean>(false);
  const [selectedIdea, setSelectedIdea] = useState<TradeIdeaRow | null>(null);
  const [accounts, setAccounts] = useState<PaperAccountOption[]>([]);
  const [simAccountId, setSimAccountId] = useState<string>("");
  const [simLots, setSimLots] = useState<number>(1);
  const [simNotes, setSimNotes] = useState<string>("Simulated from Strategy Dashboard");
  const [simExpiryDate, setSimExpiryDate] = useState("");
  const [simulating, setSimulating] = useState<boolean>(false);
  const [simSuccess, setSimSuccess] = useState<string | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  // Swing and scalp are the same dashboard over a different strategy key, so the
  // tab is view state rather than a route. The URL still carries it so a refresh,
  // a bookmark, and the /scalp-strategy redirect all land on the right tab.
  const applyMode = useCallback((next: StrategyMode) => {
    setMode(next);
    // Drop the outgoing mode's rows and show the skeleton straight away. The
    // refetch is driven by an effect, which cannot raise `loading` itself, so
    // without this the previous mode's proposals stay on screen under the new
    // mode's heading — a trend-breakout card labelled "Momentum Scalp Proposals".
    setIdeas([]);
    setLoading(true);
    // The generate modal offers a different timeframe set per mode. Leaving the
    // previous mode's value selected would post a timeframe the new mode's
    // dropdown does not even list.
    setGenTimeframe(modeConfig[next].defaultTimeframe);
    window.history.replaceState(null, "", next === "scalp" ? "/strategy?mode=scalp" : "/strategy");
  }, []);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadIdeas = useCallback(async (signal?: AbortSignal) => {
    const dateParam = dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : "";
    // The strategy filter has to go to the API. Filtering the response here instead
    // applies limit=100 across every strategy first, so whichever strategy was
    // regenerated last fills the page and this one shows stale rows or nothing.
    const strategyParam = strategyKey ? `&strategy=${encodeURIComponent(strategyKey)}` : "";
    const res = await getResearchJson(
      `/trade-ideas?limit=100&_t=${Date.now()}${dateParam}${strategyParam}`,
      signal,
    ) as { data: TradeIdeaRow[] };
    return res.data || [];
  }, [dateFilter, strategyKey]);

  const applyIdeas = useCallback((rows: TradeIdeaRow[]) => {
    setIdeas(rows);
    setError(null);
    setLoading(false);
  }, []);

  const applyIdeasError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load trade ideas."));
    setLoading(false);
  }, []);

  const refreshIdeas = useCallback(() => {
    setLoading(true);
    void loadIdeas().then(applyIdeas, applyIdeasError);
  }, [loadIdeas, applyIdeas, applyIdeasError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadIdeas(controller.signal).then(applyIdeas, applyIdeasError);
    return () => controller.abort();
  }, [loadIdeas, applyIdeas, applyIdeasError]);

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
      const reasons: string[] = [];
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
      await loadIdeas().then(applyIdeas, applyIdeasError);
    } catch (err: unknown) {
      setGenError(errorMessage(err, "Failed to generate proposals."));
    } finally {
      setGenerating(false);
    }
  };

  const openSimulateModal = async (idea: TradeIdeaRow) => {
    setSelectedIdea(idea);
    setSimLots(1);
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
        lots: Number(simLots),
        notes: simNotes,
        asOptionBuyer: true,
        expiryDate: simExpiryDate,
      });
      setSimSuccess(`Successfully simulated ${selectedIdea.side} position for ${selectedIdea.instrumentSymbol} in portfolio!`);
      setTimeout(() => {
        setShowSimulateModal(false);
      }, 1500);
    } catch (err: unknown) {
      setSimError(errorMessage(err, "Failed to open simulated position."));
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
        title={title}
        description="Proposals from the latest settled candle close. Today's open session is evaluated after the bar completes — expired historical setups are hidden."
      >
      </PageHeader>
      <div className="space-y-6">
        <Reveal>
          <Tabs
            tabs={[
              { id: "swing", label: "Swing", icon: <TrendingUp className="size-4" /> },
              { id: "scalp", label: "Scalp", icon: <Timer className="size-4" /> },
            ]}
            activeId={mode}
            onChange={(id) => applyMode(id as StrategyMode)}
          />
        </Reveal>

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
            onRefresh={refreshIdeas}
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
                <h2 className="text-lg font-bold text-white">{gridHeading} ({filteredIdeas.length})</h2>
                <p className="text-xs text-slate-400">{gridDescription}</p>
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
          isScalp={isScalp}
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
          simLots={simLots}
          setSimLots={setSimLots}
          simNotes={simNotes}
          setSimNotes={setSimNotes}
          simExpiryDate={simExpiryDate}
          setSimExpiryDate={setSimExpiryDate}
          simulating={simulating}
          simSuccess={simSuccess}
          simError={simError}
          onSubmit={handleSimulateSubmit}
        />
      </div>
    </>
  );
}
