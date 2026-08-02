"use client";

import { useCallback, useState } from "react";
import { Pin, ScrollText } from "lucide-react";
import { Tabs } from "../../../components/ui/tabs";
import { OrdersDashboard } from "../../orders/components/orders-dashboard";
import { PositionsDashboard } from "../../positions/components/positions-dashboard";

export type PositionsOrdersMode = "positions" | "orders";

export function PositionsOrdersDashboard({
  initialMode = "positions",
}: {
  initialMode?: PositionsOrdersMode;
}) {
  const [mode, setMode] = useState<PositionsOrdersMode>(initialMode);

  const applyMode = useCallback((next: PositionsOrdersMode) => {
    setMode(next);
    window.history.replaceState(
      null,
      "",
      next === "orders" ? "/positions-orders?tab=orders" : "/positions-orders",
    );
  }, []);

  const navigation = (
    <Tabs
      activeId={mode}
      onChange={(id) => applyMode(id as PositionsOrdersMode)}
      tabs={[
        { id: "positions", label: "Positions", icon: <Pin className="size-4" /> },
        { id: "orders", label: "Orders", icon: <ScrollText className="size-4" /> },
      ]}
    />
  );

  return mode === "positions"
    ? <PositionsDashboard navigation={navigation} />
    : <OrdersDashboard navigation={navigation} />;
}
