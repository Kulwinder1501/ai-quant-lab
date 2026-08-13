"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Tooltip } from "../../../components/ui/tooltip";
import { getResearchJson } from "../../research/api";
import { MarketContextHistoryChart } from "./market-context-history-chart";

export type InstitutionalFlowStance =
  | "BOTH_ACCUMULATING"
  | "BOTH_DISTRIBUTING"
  | "FOREIGN_INFLOW_DOMESTIC_OUTFLOW"
  | "FOREIGN_OUTFLOW_DOMESTIC_SUPPORT"
  | "BALANCED"
  | "UNKNOWN";

interface FlowSession {
  date: string;
  fiiCashNetCr: number | null;
  diiCashNetCr: number | null;
  combinedNetCr: number | null;
  publishedAt: string;
  source: string;
  isProvisional: boolean;
}

interface FlowSummary {
  latest: FlowSession | null;
  history: FlowSession[];
  stance: InstitutionalFlowStance;
  ageInDays: number | null;
  isStale: boolean;
  fiiTotalCr: number | null;
  diiTotalCr: number | null;
  sessionsCovered: number;
}


interface IndiaVixStatus {
  available: boolean;
  latest: { date: string; close: number; receivedAt: string; source: string } | null;
  history: Array<{ date: string; close: number; receivedAt: string; source: string }>;
  ageInDays: number | null;
  isStale: boolean;
}

interface InstitutionalContext {
  flows: FlowSummary;
  indiaVix: IndiaVixStatus;
}

const STANCE_COPY: Record<InstitutionalFlowStance, { label: string; tone: string; detail: string }> = {
  BOTH_ACCUMULATING: {
    label: "BOTH ACCUMULATING",
    tone: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    detail: "Foreign and domestic institutions were both net buyers in the cash segment.",
  },
  BOTH_DISTRIBUTING: {
    label: "BOTH DISTRIBUTING",
    tone: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    detail: "Foreign and domestic institutions were both net sellers in the cash segment.",
  },
  FOREIGN_INFLOW_DOMESTIC_OUTFLOW: {
    label: "FII BUY / DII SELL",
    tone: "bg-cyan-500/20 text-cyan-200 border-cyan-500/40",
    detail: "Foreign money came in while domestic institutions took the other side.",
  },
  FOREIGN_OUTFLOW_DOMESTIC_SUPPORT: {
    label: "FII SELL / DII SUPPORT",
    tone: "bg-amber-500/20 text-amber-200 border-amber-500/40",
    detail: "Foreign money left and domestic institutions absorbed the supply.",
  },
  BALANCED: {
    label: "BALANCED",
    tone: "bg-slate-500/20 text-slate-300 border-slate-500/40",
    detail: "Both legs settled within ₹100 Cr of flat, so neither side dominated.",
  },
  UNKNOWN: {
    label: "NOT MEASURED",
    tone: "bg-slate-500/20 text-slate-400 border-slate-500/40",
    detail: "At least one leg was absent upstream, so the session has no stance.",
  },
};

function formatCrore(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
}

function flowTone(value: number | null): string {
  if (value === null) return "text-slate-500";
  if (value > 0) return "text-emerald-300";
  if (value < 0) return "text-rose-300";
  return "text-slate-300";
}

function formatSession(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Shared height for the flows card and the market-context chart beside it.
 *
 * Sized to the chart card's natural height: `p-5` padding, its header block, and the `h-80`
 * (320px) plot area. Only applied from `xl`, where the two sit side by side; stacked on narrower
 * screens each card takes the height it needs and neither has to match the other.
 */
const CONTEXT_CARD_HEIGHT = "xl:h-[470px]";

export function InstitutionalContextCards() {
  const [context, setContext] = useState<InstitutionalContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadContext = useCallback(async () => {
    const response = (await getResearchJson("/institutional-context?sessions=60")) as {
      data: InstitutionalContext;
    };
    return response.data;
  }, []);

  const applyContext = useCallback((data: InstitutionalContext) => {
    setContext(data);
    setError(null);
    setLoading(false);
  }, []);

  const applyContextError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "Could not load institutional context.");
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadContext().then(applyContext, applyContextError);
    // Flows are published once a day after the close, so a slow poll is enough to
    // pick up a collector run without hammering the endpoint.
    const interval = setInterval(() => {
      void loadContext().then(applyContext, applyContextError);
    }, 300_000);
    return () => clearInterval(interval);
  }, [loadContext, applyContext, applyContextError]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <GlassPanel className="p-6 border-white/10 bg-slate-900/60">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">FII / DII Institutional Flows</span>
          <div className="mt-4 h-24 animate-pulse rounded-xl bg-white/5" />
        </GlassPanel>
      </div>
    );
  }

  if (error || !context) {
    return (
      <GlassPanel className="p-6 border-amber-500/30 bg-amber-500/5">
        <h3 className="text-base font-bold text-amber-200">Institutional context unavailable</h3>
        <p className="mt-1 text-xs text-amber-100/70">{error ?? "The API returned no payload."}</p>
      </GlassPanel>
    );
  }

  const { flows, indiaVix } = context;
  const stance = STANCE_COPY[flows.stance];

  return (
    /**
     * Both cards are pinned to one height instead of letting content decide it. The flows card
     * carries a ten-session list and so was always the taller of the two, stretching the row and
     * leaving the chart beside it looking stunted. Capping the row and scrolling the list inside
     * keeps the pair level.
     *
     * The class is written out rather than composed from a variable: Tailwind scans source text
     * for literal class names, so an interpolated `xl:${...}` produces no CSS at all.
     */
    <div className={`grid grid-cols-1 gap-4 xl:grid-cols-2 ${CONTEXT_CARD_HEIGHT}`}>
      {/* FII / DII Institutional Flows */}
      <GlassPanel className="flex min-h-0 flex-col overflow-hidden p-6 border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/20">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">
              Institutional Cash Flows
            </span>
            <h3 className="mt-1 text-lg font-bold text-white">FII / DII Activity</h3>
          </div>
          <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-slate-400">
            <Tooltip content="Net cash-segment buying minus selling, published by NSE after each close.">
              NSE EOD
            </Tooltip>
          </span>
        </div>

        {!flows.latest ? (
          <div className="mt-5 rounded-xl border border-slate-600/40 bg-slate-900/60 p-4">
            <p className="text-sm font-semibold text-slate-300">No print collected yet</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Run <code className="rounded bg-black/40 px-1 font-mono text-cyan-300">npm run data:collect:institutional</code>{" "}
              or start <code className="rounded bg-black/40 px-1 font-mono text-cyan-300">npm run scheduler</code>, which
              collects at 18:30 IST on trading days.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <Tooltip content="Foreign Institutional Investors / Foreign Portfolio Investors">FII / FPI</Tooltip>
                </span>
                <p className={`mt-1 font-mono text-xl font-extrabold ${flowTone(flows.latest.fiiCashNetCr)}`}>
                  {formatCrore(flows.latest.fiiCashNetCr)}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <Tooltip content="Domestic Institutional Investors — mutual funds, insurers, banks">DII</Tooltip>
                </span>
                <p className={`mt-1 font-mono text-xl font-extrabold ${flowTone(flows.latest.diiCashNetCr)}`}>
                  {formatCrore(flows.latest.diiCashNetCr)}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${stance.tone}`}>
                {stance.label}
              </span>
              <span className="text-xs text-slate-400">
                Combined{" "}
                <span className={`font-mono font-bold ${flowTone(flows.latest.combinedNetCr)}`}>
                  {formatCrore(flows.latest.combinedNetCr)}
                </span>
              </span>
              {flows.isStale && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                  STALE • {flows.ageInDays}d OLD
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{stance.detail}</p>

            {/* The one region that gives: header, totals and footer stay pinned while the session
                list scrolls, so the card holds the shared height no matter how many sessions the
                collector has gathered. `min-h-0` is required -- without it a flex child refuses to
                shrink below its content and the overflow never engages. */}
            <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-white/5 pt-3">
              <div className="flex shrink-0 items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <span>Last {flows.sessionsCovered} session{flows.sessionsCovered === 1 ? "" : "s"}</span>
                <span className="font-mono normal-case">
                  FII <span className={flowTone(flows.fiiTotalCr)}>{formatCrore(flows.fiiTotalCr)}</span>
                  {" · "}
                  DII <span className={flowTone(flows.diiTotalCr)}>{formatCrore(flows.diiTotalCr)}</span>
                </span>
              </div>
              <ul className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto custom-scrollbar pr-1">
                {flows.history.slice(0, 10).map((session) => (
                  <li
                    key={session.date}
                    className="flex items-center justify-between rounded-lg bg-white/[0.02] px-2 py-1 font-mono text-[11px]"
                  >
                    <span className="text-slate-400">{formatSession(session.date)}</span>
                    <span className="flex gap-3">
                      <span className={flowTone(session.fiiCashNetCr)}>{formatCrore(session.fiiCashNetCr)}</span>
                      <span className={flowTone(session.diiCashNetCr)}>{formatCrore(session.diiCashNetCr)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="shrink-0 pt-3 text-[10px] text-slate-500">
              Session {formatSession(flows.latest.date)} · collected{" "}
              {new Date(flows.latest.publishedAt).toLocaleString("en-IN")}
            </p>
          </>
        )}
      </GlassPanel>
      <MarketContextHistoryChart flows={flows.history} indiaVix={indiaVix}  />
    </div>
  );
}
