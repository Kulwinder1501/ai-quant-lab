"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getResearchJson } from "../../research/api";

interface IndexDriver {
  symbol: string;
  name: string;
  weightPct: number;
  dayPct: number;
  last: number | null;
  estPts: number;
}

interface DriverTapeMetrics {
  advanceShare: number;
  declineShare: number;
  concentration: number;
  coverage: number;
  quotedCount: number;
  rosterCount: number;
  estNetPts: number;
}

interface IndexDriversResponse {
  index: string;
  label?: string;
  indexLevel: number | null;
  estNetPts: number;
  asOf: string;
  disclaimer: string;
  supported?: string[];
  tape?: DriverTapeMetrics | null;
  drivers: IndexDriver[];
}

/** Indices with approximate constituent weight rosters on the API. */
const DRIVER_INDEX_KEYS = new Set(["NIFTY50", "BANKNIFTY", "FINNIFTY", "SENSEX"]);

function normalizeDriverIndex(symbol: string): string | null {
  const key = symbol.trim().toUpperCase().replace(/\s+/g, "");
  if (key === "NIFTY" || key === "NIFTY50") return "NIFTY50";
  if (DRIVER_INDEX_KEYS.has(key)) return key;
  return null;
}

function tileBackground(estPts: number, indexKey: string): string {
  // Bank/Fin contributions are larger in absolute pts; scale intensity by index.
  const scale = indexKey === "BANKNIFTY" || indexKey === "FINNIFTY" ? 80 : 40;
  const mag = Math.min(Math.abs(estPts) / scale, 1);
  if (estPts >= 0) {
    const a = 0.18 + mag * 0.45;
    return `rgba(16, 185, 129, ${a.toFixed(3)})`;
  }
  const a = 0.18 + mag * 0.45;
  return `rgba(244, 63, 94, ${a.toFixed(3)})`;
}

function formatPts(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatIndexLevel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

/**
 * Index drivers contribution heatmap (weight% × day% × index / 10000).
 * Follows the selected Market Watch / dashboard index when a roster exists.
 */
export function VolatilityHeatmap({
  selectedSymbol = "NIFTY50",
}: {
  selectedSymbol?: string;
}) {
  const indexKey = normalizeDriverIndex(selectedSymbol);
  const [payload, setPayload] = useState<IndexDriversResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "unsupported">(
    indexKey ? "loading" : "unsupported",
  );
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!indexKey) {
        setPayload(null);
        setStatus("unsupported");
        return;
      }
      setRefreshing(true);
      try {
        const json = (await getResearchJson(
          `/index-drivers?index=${encodeURIComponent(indexKey)}`,
          signal,
        )) as IndexDriversResponse;
        if (!json || !Array.isArray(json.drivers)) {
          setStatus("error");
          return;
        }
        setPayload(json);
        setStatus("ready");
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return;
        setStatus((current) => (current === "ready" ? current : "error"));
      } finally {
        setRefreshing(false);
      }
    },
    [indexKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (!indexKey) {
      const unsupportedUpdate = setTimeout(() => {
        setPayload(null);
        setStatus("unsupported");
      }, 0);
      return () => clearTimeout(unsupportedUpdate);
    }
    const initialLoad = setTimeout(() => {
      setStatus("loading");
      setPayload(null);
      void load(controller.signal);
    }, 0);
    const interval = setInterval(() => {
      void load();
    }, 60_000);
    return () => {
      controller.abort();
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [indexKey, load]);

  const drivers = payload?.drivers ?? [];
  const estNet = payload?.estNetPts ?? 0;
  const netPositive = estNet >= 0;
  const label = payload?.label ?? indexKey ?? selectedSymbol;
  const activeKey = payload?.index ?? indexKey ?? "NIFTY50";

  return (
    <GlassPanel className="flex h-full min-h-0 flex-col rounded-md border-white/5 bg-slate-950/60 p-3">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
            Heatmap{" "}
            <span className="text-white">{label} drivers</span>
            {status === "ready" && (
              <span className="ml-1 font-mono font-medium normal-case tracking-normal text-slate-400">
                @ {formatIndexLevel(payload?.indexLevel ?? null)}
              </span>
            )}
          </h3>
          {status === "ready" && (
            <span
              className={`font-mono text-[11px] font-semibold tabular-nums ${
                netPositive ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              Est. net {formatPts(estNet)} pts
            </span>
          )}
          {status === "ready" && payload?.tape && (
            <span className="font-mono text-[10px] tabular-nums text-slate-400">
              Adv {(payload.tape.advanceShare * 100).toFixed(0)}%
              {" · "}
              Conc {(payload.tape.concentration * 100).toFixed(0)}%
              {" · "}
              Cov {(payload.tape.coverage * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing || !indexKey}
          className="inline-flex items-center gap-1 rounded border border-white/10 bg-slate-900/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-slate-400 transition hover:border-white/20 hover:text-slate-200 disabled:opacity-50"
        >
          <svg
            viewBox="0 0 16 16"
            className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 8A5.5 5.5 0 1 1 11 3.6M13.5 3v3.2H10.3"
            />
          </svg>
          Refresh
        </button>
      </div>

      {status === "unsupported" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[10px] leading-relaxed text-slate-500">
          Drivers heatmap is available for{" "}
          <span className="text-slate-300">NIFTY50, BANKNIFTY, FINNIFTY, SENSEX</span>
          . Select one of those in Market Watch.
        </div>
      ) : drivers.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2 text-center text-[10px] italic text-slate-500">
          {status === "loading"
            ? `Loading ${label} drivers…`
            : "Driver quotes unavailable (Yahoo). Try Refresh."}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-1.5 overflow-y-auto custom-scrollbar sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
          {drivers.map((item) => {
            const positive = item.estPts >= 0;
            const tone = positive ? "text-emerald-400" : "text-rose-400";
            return (
              <div
                key={item.symbol}
                className="flex min-h-[72px] flex-col justify-between rounded border border-white/5 px-2 py-1.5"
                style={{ backgroundColor: tileBackground(item.estPts, activeKey) }}
                title={`${item.symbol}: ${formatPts(item.estPts)} pts · day ${formatPct(item.dayPct)} · wt ~${item.weightPct.toFixed(1)}%`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[10px] font-black uppercase tracking-wide text-white">
                    {item.symbol}
                  </div>
                  <div className="truncate text-[8px] leading-tight text-slate-400">
                    {item.name}
                  </div>
                </div>
                <div className={`mt-0.5 font-mono text-[13px] font-bold tabular-nums leading-none ${tone}`}>
                  {formatPts(item.estPts)}{" "}
                  <span className="text-[9px] font-semibold opacity-80">pts</span>
                </div>
                <div className="mt-1 flex items-end justify-between gap-1">
                  <span className={`font-mono text-[9px] font-semibold tabular-nums ${tone}`}>
                    {formatPct(item.dayPct)}
                  </span>
                  <span className="font-mono text-[8px] tabular-nums text-slate-500">
                    ~{item.weightPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-2 shrink-0 text-[8px] leading-snug text-slate-500">
        {status === "unsupported"
          ? "No constituent weight roster for this index."
          : payload?.disclaimer ??
            "Est. points = weight% × day% × index / 10000. Weights are approximate (not live exchange free-float)."}
        {payload?.asOf ? ` · ${formatClock(payload.asOf)}` : ""}
      </p>
    </GlassPanel>
  );
}
