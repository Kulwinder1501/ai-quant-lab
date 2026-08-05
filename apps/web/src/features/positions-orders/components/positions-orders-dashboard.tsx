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
    let url = "/portfolio";
    if (next === "orders") url = "/portfolio?tab=orders";
    else if (next === "history") url = "/portfolio?tab=history";
    
    window.history.replaceState(null, "", url);
  }, []);

  const navigation = (
    <Tabs
      activeId={mode}
      onChange={(id) => applyMode(id as PositionsOrdersMode)}
      tabs={[
        { id: "positions", label: "Positions", icon: <Pin className="size-4" /> },
        { id: "orders", label: "Orders", icon: <ScrollText className="size-4" /> },
        { id: "history", label: "History", icon: <ScrollText className="size-4" /> },
      ]}
    />
  );

  if (mode === "history") {
    return <TradeHistoryDashboard navigation={navigation} />;
  }
  return mode === "positions"
    ? <PositionsDashboard navigation={navigation} />
    : <OrdersDashboard navigation={navigation} />;
}
