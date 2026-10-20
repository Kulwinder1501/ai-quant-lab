"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ShieldAlert } from "lucide-react";
import {
  AddStockCard,
  EquityAlertsInbox,
  EquityHeader,
  EquityStockDetailDrawer,
  EquityWatchlistTable,
  fetchEquityAlerts,
  fetchEquityWatchlist,
  RemoveStockModal,
  removeStockFromWatchlist,
  type AlertRecord,
  type WatchlistStockItem,
} from "../../../features/equity";
import { useToast } from "../../../components/ui/toast";

export default function EquityWatchPage() {
  const { toast } = useToast();
  const [stocks, setStocks] = useState<WatchlistStockItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  // Defect 2: Status is UNKNOWN until the API responds
  const [sourceStatus, setSourceStatus] = useState<string>("UNKNOWN");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  // Detail Drawer State
  const [selectedStockForDetail, setSelectedStockForDetail] = useState<WatchlistStockItem | null>(null);

  // Remove Modal State
  const [stockForRemoval, setStockForRemoval] = useState<WatchlistStockItem | null>(null);
  const [isRemoving, setIsRemoving] = useState<boolean>(false);

  // Alerts State
  const [alertsSummary, setAlertsSummary] = useState<AlertRecord[]>([]);
  const [isAlertsInboxOpen, setIsAlertsInboxOpen] = useState<boolean>(false);
  const [selectedStockForAlerts, setSelectedStockForAlerts] = useState<string | undefined>(undefined);

  const loadAlertsSummary = useCallback(async () => {
    try {
      const res = await fetchEquityAlerts();
      setAlertsSummary(res);
    } catch {
      // Non-blocking for summary badge
    }
  }, []);

  const unreadAlertsCount = useMemo(() => {
    return alertsSummary.filter((a) => a.status === "NEW").length;
  }, [alertsSummary]);

  const alertCountsByStockId = useMemo(() => {
    const map: Record<string, { newCount: number; totalCount: number }> = {};
    for (const a of alertsSummary) {
      if (!map[a.stock_id]) {
        map[a.stock_id] = { newCount: 0, totalCount: 0 };
      }
      map[a.stock_id].totalCount += 1;
      if (a.status === "NEW") {
        map[a.stock_id].newCount += 1;
      }
    }
    return map;
  }, [alertsSummary]);

  const loadWatchlist = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setIsLoading(true);
      setError(null);
      const res = await fetchEquityWatchlist();
      setStocks(res.stocks);
      setTotalCount(res.totalCount);
      setSourceStatus(res.sourceStatus);
      setLastRefreshedAt(new Date());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load equity watchlist.";
      setError(msg);
      setSourceStatus("UNKNOWN");
      toast({
        title: "Watchlist Update Failed",
        description: msg,
        variant: "error",
      });
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [toast]);

  // Defect 9: Avoid calling setState synchronously in the effect body
  useEffect(() => {
    let isCancelled = false;
    void fetchEquityWatchlist()
      .then((res) => {
        if (!isCancelled) {
          setStocks(res.stocks);
          setTotalCount(res.totalCount);
          setSourceStatus(res.sourceStatus);
          setLastRefreshedAt(new Date());
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!isCancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load equity watchlist.";
          setError(msg);
          setSourceStatus("UNKNOWN");
          setIsLoading(false);
        }
      });

    void fetchEquityAlerts()
      .then((res) => {
        if (!isCancelled) {
          setAlertsSummary(res);
        }
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
    };
  }, []);

  const handleStockAdded = (_newStock: WatchlistStockItem) => {
    toast({
      title: "Stock Added",
      description: `${_newStock.symbol} (${_newStock.exchange}) added to active watchlist.`,
      variant: "success",
    });
    // Refresh to get full list with latest metrics
    loadWatchlist(false);
    void loadAlertsSummary();
  };

  const handleConfirmRemoval = async () => {
    if (!stockForRemoval) return;

    try {
      setIsRemoving(true);
      await removeStockFromWatchlist(stockForRemoval.id);

      toast({
        title: "Stock Removed",
        description: `${stockForRemoval.symbol} removed from active watchlist. History is preserved.`,
        variant: "info",
      });

      setStockForRemoval(null);
      loadWatchlist(false);
    } catch (err: unknown) {
      toast({
        title: "Removal Failed",
        description: err instanceof Error ? err.message : "Failed to remove stock.",
        variant: "error",
      });
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Header & Quick Controls */}
      <EquityHeader
        totalCount={totalCount}
        sourceStatus={sourceStatus}
        lastRefreshedAt={lastRefreshedAt}
        isLoading={isLoading}
        onRefresh={() => {
          loadWatchlist(true);
          void loadAlertsSummary();
        }}
        unreadAlertsCount={unreadAlertsCount}
        onOpenAlerts={() => {
          setSelectedStockForAlerts(undefined);
          setIsAlertsInboxOpen(true);
        }}
      />

      {/* 2. Source-Down / Rate-Limited Alert Banner (Gate S11) */}
      {(sourceStatus === "UNAVAILABLE" || sourceStatus === "RATE_LIMITED") && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-200">
          <ShieldAlert className="size-5 shrink-0 text-rose-400 mt-0.5" />
          <div className="space-y-1">
            <h4 className="font-bold text-sm text-white">
              {sourceStatus === "RATE_LIMITED"
                ? "Yahoo Finance Rate-Limit Cooldown Active"
                : "Upstream Data Source Unavailable"}
            </h4>
            <p className="text-slate-300">
              {sourceStatus === "RATE_LIMITED"
                ? "The upstream Yahoo Finance feed returned HTTP 429. Cooldown circuit breaker is active for 5 minutes. No retries will be attempted until cooldown expires."
                : "Yahoo Finance is currently failing or unreachable. Automated collections are paused and stock validation will be rejected until recovery."}
            </p>
          </div>
        </div>
      )}

      {/* 3. General Error State Banner (Gate S11) */}
      {error && !isLoading && (
        <div className="flex items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-200">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="size-5 text-rose-400" />
            <div>
              <span className="font-semibold text-white">Error connecting to Equity API: </span>
              <span>{error}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              loadWatchlist(true);
              void loadAlertsSummary();
            }}
            className="rounded-lg bg-rose-500/20 px-3 py-1.5 font-semibold text-rose-300 hover:bg-rose-500/30 transition border border-rose-500/30"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* 4. Add Stock Box */}
      <AddStockCard
        onStockAdded={handleStockAdded}
        disabled={sourceStatus === "UNAVAILABLE" || sourceStatus === "RATE_LIMITED"}
        lastRefreshedAt={lastRefreshedAt}
      />

      {/* 5. Watchlist Table (Handles Loading, Empty, Populated, and Error States) */}
      <EquityWatchlistTable
        stocks={stocks}
        isLoading={isLoading}
        hasError={Boolean(error)}
        alertCountsByStockId={alertCountsByStockId}
        onOpenStockAlerts={(stock) => {
          setSelectedStockForAlerts(stock.symbol);
          setIsAlertsInboxOpen(true);
        }}
        onSelectStock={(stock) => setSelectedStockForDetail(stock)}
        onRemoveStock={(stock) => setStockForRemoval(stock)}
      />

      {/* 6. Stock Detail Slide-Over Drawer */}
      <EquityStockDetailDrawer
        stock={selectedStockForDetail}
        isOpen={Boolean(selectedStockForDetail)}
        onClose={() => setSelectedStockForDetail(null)}
      />

      {/* 7. Remove Stock Confirmation Modal */}
      <RemoveStockModal
        stock={stockForRemoval}
        isOpen={Boolean(stockForRemoval)}
        isRemoving={isRemoving}
        onClose={() => setStockForRemoval(null)}
        onConfirm={handleConfirmRemoval}
      />

      {/* 8. Alerts Inbox Drawer */}
      <EquityAlertsInbox
        isOpen={isAlertsInboxOpen}
        onClose={() => setIsAlertsInboxOpen(false)}
        stocks={stocks}
        selectedStockSymbol={selectedStockForAlerts}
        onAlertStatusChanged={() => {
          void loadAlertsSummary();
        }}
      />
    </div>
  );
}
