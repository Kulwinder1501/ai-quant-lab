"use client";

import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { Download } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { PageHeader } from "../../../components/layout/page-header";
import type { PaperAccountSummary, PaperAccountFullSummary } from "../../paper-trading/domain";
import { OrdersFilterBar } from "./orders-filter-bar";
import { OrdersStats } from "./orders-stats";
import { OrdersTable } from "./orders-table";
import type { OrderRow } from "./orders-table";

export function OrdersDashboard() {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<PaperAccountFullSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterSide, setFilterSide] = useState<string>("ALL");
  const [filterOutcome, setFilterOutcome] = useState<string>("ALL");

  // 1. Fetch Paper Accounts. Pure I/O: no state writes, so an effect can call it
  // without cascading a render.
  const loadAccounts = useCallback(async (signal?: AbortSignal) => {
    const res = (await getResearchJson("/paper-accounts", signal)) as { data?: PaperAccountSummary[] };
    return res?.data || [];
  }, []);

  const applyAccounts = useCallback((list: PaperAccountSummary[]) => {
    setAccounts(list);
    if (list.length > 0 && !selectedAccountId) {
      setSelectedAccountId(list[0].id);
    }
  }, [selectedAccountId]);

  const applyAccountsError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load paper trading accounts."));
  }, []);

  // 2. Fetch Account Summary (Closed Trades / Orders)
  const loadSummary = useCallback(async (accId: string, signal?: AbortSignal) => {
    const res = (await getResearchJson(`/paper-accounts/${accId}/summary`, signal)) as { data?: PaperAccountFullSummary };
    return res?.data;
  }, []);

  const applySummary = useCallback((data?: PaperAccountFullSummary) => {
    if (data) {
      setSummary(data);
    }
    setError(null);
    setLoading(false);
  }, []);

  const applySummaryError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load completed order history."));
    setLoading(false);
  }, []);

  const refreshSummary = useCallback(() => {
    if (!selectedAccountId) return;
    setLoading(true);
    void loadSummary(selectedAccountId).then(applySummary, applySummaryError);
  }, [selectedAccountId, loadSummary, applySummary, applySummaryError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAccounts(controller.signal).then(applyAccounts, applyAccountsError);
    return () => controller.abort();
  }, [loadAccounts, applyAccounts, applyAccountsError]);

  useEffect(() => {
    if (!selectedAccountId) return;
    const controller = new AbortController();
    void loadSummary(selectedAccountId, controller.signal).then(applySummary, applySummaryError);

    const timer = setInterval(refreshSummary, 5000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selectedAccountId, loadSummary, applySummary, applySummaryError, refreshSummary]);

  // Filter and Compute Order Analytics
  const filteredOrders = useMemo<OrderRow[]>(() => {
    const list = summary?.closedTrades || [];
    return list.filter((order) => {
      const sym = order.instrumentSymbol || "NIFTY50";
      if (filterSymbol !== "ALL" && sym !== filterSymbol) return false;
      if (filterSide !== "ALL" && order.side !== filterSide) return false;
      
      const pnl = order.realizedPnl || 0;
      if (filterOutcome === "WIN" && pnl <= 0) return false;
      if (filterOutcome === "LOSS" && pnl >= 0) return false;

      return true;
    });
  }, [summary?.closedTrades, filterSymbol, filterSide, filterOutcome]);

  const orderStats = useMemo(() => {
    const list = filteredOrders;
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let totalVolume = 0;

    list.forEach((ord) => {
      const p = ord.realizedPnl || 0;
      totalPnl += p;
      if (p > 0) wins++;
      else if (p < 0) losses++;
      totalVolume += ord.fillPrice * ord.quantity;
    });

    const total = list.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    return {
      total,
      wins,
      losses,
      winRate,
      totalPnl,
      totalVolume,
    };
  }, [filteredOrders]);

  return (
      <div className="space-y-6">

        {/* Account & Filter Control Bar */}
        <Reveal>
          <OrdersFilterBar
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            setSelectedAccountId={setSelectedAccountId}
            filterSymbol={filterSymbol}
            setFilterSymbol={setFilterSymbol}
            filterSide={filterSide}
            setFilterSide={setFilterSide}
            filterOutcome={filterOutcome}
            setFilterOutcome={setFilterOutcome}
            onRefresh={refreshSummary}
          />
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm font-semibold">
            {error}
          </div>
        )}

        {/* Execution Summary Cards */}
        <Reveal delayMs={100}>
          <div className="flex justify-end mb-4">
            <button
              type="button"
              onClick={() => exportToCsv(filteredOrders, "orders")}
              disabled={filteredOrders.length === 0}
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
          <OrdersStats orderStats={orderStats} />
        </Reveal>

        {/* Completed Orders Table */}
        <Reveal delayMs={200}>
          <OrdersTable filteredOrders={filteredOrders} summary={summary} loading={loading} />
        </Reveal>
      </div>
  );
}
