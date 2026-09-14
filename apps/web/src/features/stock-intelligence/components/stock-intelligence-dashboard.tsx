"use client";

import { Bookmark, Briefcase } from "lucide-react";
import { useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Tabs } from "../../../components/ui/tabs";
import { isStockIntelligenceUiEnabled } from "../enabled";

export function StockIntelligenceDashboard() {
  const enabled = isStockIntelligenceUiEnabled();
  const [tab, setTab] = useState("holdings");

  if (!enabled) {
    return (
      <GlassPanel className="max-w-2xl p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">Intelligence</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-white">Stock Intelligence</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Gate 7 has not passed on the current-roster 2015–2024 replay. Snapshots can be
          written; investor-facing HTTP and this tab stay off until a formal acceptance
          report passes all 10 criteria.
        </p>
        <p className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          UNAVAILABLE — API and UI remain disabled. Re-run
          data:evaluate:stock-intelligence-gate7 after a survivorship-safe historical
          membership archive exists. Passing the report does not flip the flags for you.
        </p>
      </GlassPanel>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        <h1 className="text-2xl font-black tracking-tight text-white">Stock Intelligence</h1>
        <p className="mt-1 text-sm text-slate-400">
          One outlook engine. Holdings and Watchlist are consumer overlays, not a second model.
        </p>
        <div className="mt-4">
          <Tabs
            tabs={[
              { id: "holdings", label: "My Holdings", icon: <Briefcase className="size-4" /> },
              { id: "watchlist", label: "Watchlist", icon: <Bookmark className="size-4" /> },
            ]}
            activeId={tab}
            onChange={setTab}
          />
        </div>
      </div>
      <GlassPanel className="mt-6 p-8">
        <h2 className="text-lg font-semibold text-slate-100">
          {tab === "holdings" ? "Holding context" : "Watchlist context"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          {tab === "holdings"
            ? "Entry price, quantity, and thesis overlay the shared outlook. No names are listed until you add a holding."
            : "Target price, target entry, and notes overlay the shared outlook. This is not the scanner instrument registry."}
        </p>
        <p className="mt-4 text-sm text-slate-500">No outlooks to show for this context yet.</p>
      </GlassPanel>
    </div>
  );
}
