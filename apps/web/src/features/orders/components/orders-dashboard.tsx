"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Download } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { PageHeader } from "../../../components/layout/page-header";
import type { PaperAccountSummary, PaperAccountFullSummary } from "../../paper-trading/domain";
import { OrdersFilterBar } from "./orders-filter-bar";
import { OrdersStats } from "./orders-stats";
import { OrdersTable } from "./orders-table";

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

  // 1. Fetch Paper Accounts
  const fetchAccounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = (await getResearchJson("/paper-accounts", signal)) as { data: PaperAccountSummary[] };
      const list = res?.data || [];
      setAccounts(list);
      if (list.length > 0 && !selectedAccountId) {
        setSelectedAccountId(list[0].id);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load paper trading accounts.");
      }
    }
  }, [selectedAccountId]);

  // 2. Fetch Account Summary (Closed Trades / Orders)
  const fetchSummary = useCallback(async (accId: string, signal?: AbortSignal) => {
    if (!accId) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await getResearchJson(`/paper-accounts/${accId}/summary`, signal)) as { data: PaperAccountFullSummary };
      if (res?.data) {
        setSummary(res.data);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load completed order history.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(controller.signal);
    return () => controller.abort();
  }, [fetchAccounts]);

  useEffect(() => {
    if (!selectedAccountId) return;
    const controller = new AbortController();
    fetchSummary(selectedAccountId, controller.signal);

    const timer = setInterval(() => {
      fetchSummary(selectedAccountId);
    }, 5000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selectedAccountId, fetchSummary]);

  // Filter and Compute Order Analytics
  const filteredOrders = useMemo(() => {
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
    <>
      <PageHeader
        eyebrow="Autonomous AI Trading Lab"
        title="Completed AI Orders & Execution Log"
        description="Review closed quantitative trade executions, algorithmic exit reasons (Take-Profit vs Stop-Loss), and realized P&L auditing."
        connectionLabel={`Auditing Account: ${accounts.find((a) => a.id === selectedAccountId)?.name || "Default"}`}
      />
      <div className="mt-10">
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
            onRefresh={() => selectedAccountId && fetchSummary(selectedAccountId)}
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
    </div>
    </>
  );
}
