"use client";

import React, { useState } from "react";
import { DepthHeatmapPanel } from "./depth-heatmap-panel";
import { DepthHistoryPanel } from "./depth-history-panel";
import { DepthLadderPanel } from "./depth-ladder-panel";

type DepthMode = "ladder" | "history" | "heatmap";

const MODES: ReadonlyArray<{ id: DepthMode; label: string; hint: string }> = [
  { id: "ladder", label: "Live ladder", hint: "The newest stored book, refreshed every two seconds." },
  { id: "history", label: "Session history", hint: "Spread and imbalance across one trading day." },
  { id: "heatmap", label: "Liquidity heatmap", hint: "Resting quantity by price and time, with playback." },
];

/**
 * The Depth tab: the order book now, across a day, or as a price-by-time heatmap. Both read the collector's stored frames, not the broker.
 * Only the selected view is mounted, so the ladder's two-second poll stops while the history is open.
 */
export function DepthView({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [mode, setMode] = useState<DepthMode>("ladder");

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1 w-fit" role="group" aria-label="Depth view">
        {MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            title={option.hint}
            aria-pressed={mode === option.id}
            onClick={() => setMode(option.id)}
            className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
              mode === option.id ? "bg-violet-500/20 text-violet-200" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {mode === "ladder" && <DepthLadderPanel underlying={underlying} nowMs={nowMs} />}
      {mode === "history" && <DepthHistoryPanel underlying={underlying} nowMs={nowMs} />}
      {mode === "heatmap" && <DepthHeatmapPanel underlying={underlying} nowMs={nowMs} />}
    </div>
  );
}
