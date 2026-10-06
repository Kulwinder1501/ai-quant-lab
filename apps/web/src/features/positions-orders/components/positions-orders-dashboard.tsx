"use client";

import { useCallback, useState } from "react";
import { Pin, ScrollText } from "lucide-react";
import { Tabs } from "../../../components/ui/tabs";
import { OrdersDashboard } from "../../orders/components/orders-dashboard";
import { PositionsDashboard } from "../../positions/components/positions-dashboard";
import { TradeHistoryDashboard } from "../../trade-history/components/trade-history-dashboard";

export type PositionsOrdersMode = "positions" | "orders" | "history";

export function PositionsOrdersDashboard({
  initialMode = "positions",
}: {
  initialMode?: PositionsOrdersMode;
}) {
  const [mode, setMode] = useState<PositionsOrdersMode>(initialMode);

  const applyMode = useCallback((next: PositionsOrdersMode) => {
    setMode(next);
    let url = "/positions-orders";
    if (next === "orders") url = "/positions-orders?tab=orders";
    else if (next === "history") url = "/positions-orders?tab=history";
    
    window.history.replaceState(null, "", url);
  }, []);

  return (
    <div className="flex h-full flex-col font-sans">
      <div className="px-6 py-4 shrink-0">
        <h1 className="text-2xl font-black text-white tracking-tight">Portfolio & Live Trading</h1>
        <p className="mt-1 text-sm text-slate-400">
          Track open positions, review completed orders, and audit the full historical trade ledger.
        </p>
        <div className="mt-4">
          <Tabs
            activeId={mode}
            onChange={(id) => applyMode(id as PositionsOrdersMode)}
            tabs={[
              { id: "positions", label: "Positions", icon: <Pin className="size-4" /> },
              { id: "orders", label: "Orders", icon: <ScrollText className="size-4" /> },
              { id: "history", label: "Trade History", icon: <ScrollText className="size-4" /> },
            ]}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
        {mode === "history" && <TradeHistoryDashboard />}
        {mode === "positions" && <PositionsDashboard />}
        {mode === "orders" && <OrdersDashboard />}
      </div>
    </div>
  );
}
