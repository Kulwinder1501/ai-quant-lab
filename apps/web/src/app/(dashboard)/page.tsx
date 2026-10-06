"use client";

import { useState } from "react";
import { MarketScannerDashboard } from "../../features/scanner/components/market-scanner-dashboard";
import { BacktestingDashboard } from "../../features/backtesting/components/backtesting-dashboard";
import { classNames } from "../../components/ui/class-names";

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"scanner" | "backtesting">("scanner");

  return (
    <div className="flex h-full flex-col p-4 lg:p-8">
      {/* Tabs Header */}
      <div className="mb-6 flex shrink-0 border-b border-white/10">
        <button
          onClick={() => setActiveTab("scanner")}
          className={classNames(
            "px-6 py-3 text-sm font-bold uppercase tracking-wider transition-colors",
            activeTab === "scanner"
              ? "border-b-2 border-cyan-400 text-cyan-300"
              : "text-slate-400 hover:text-slate-200"
          )}
        >
          Market Scanner
        </button>
        <button
          onClick={() => setActiveTab("backtesting")}
          className={classNames(
            "px-6 py-3 text-sm font-bold uppercase tracking-wider transition-colors",
            activeTab === "backtesting"
              ? "border-b-2 border-cyan-400 text-cyan-300"
              : "text-slate-400 hover:text-slate-200"
          )}
        >
          Backtesting
        </button>
      </div>

      {/* Tab Content */}
      <div className="min-h-0 flex-1">
        {activeTab === "scanner" && <MarketScannerDashboard />}
        {activeTab === "backtesting" && <BacktestingDashboard />}
      </div>
    </div>
  );
}
