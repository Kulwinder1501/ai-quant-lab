"use client";

import React, { memo, useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface FlowPoint {
  date: string;
  fiiCashNetCr: number | null;
  diiCashNetCr: number | null;
}

interface VixPoint {
  date: string;
  close: number;
}

interface Props {
  flows: FlowPoint[];
  indiaVix: { available: boolean; history: VixPoint[]; isStale: boolean; ageInDays: number | null };
}

interface ChartPoint {
  date: string;
  label: string;
  fii: number | null;
  dii: number | null;
  vix: number | null;
}

function mergeSeries(props: Props): ChartPoint[] {
  const points = new Map<string, ChartPoint>();
  const get = (date: string): ChartPoint => {
    const existing = points.get(date);
    if (existing) return existing;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    const created = {
      date,
      label: parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }),
      fii: null,
      dii: null,
      vix: null,
    };
    points.set(date, created);
    return created;
  };
  for (const row of props.flows) Object.assign(get(row.date), { fii: row.fiiCashNetCr, dii: row.diiCashNetCr });
  for (const row of props.indiaVix.history) get(row.date).vix = row.close;
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function compactCrore(value: number): string {
  return `${value < 0 ? "−" : ""}₹${Math.abs(value / 1000).toFixed(1)}k`;
}

export const MarketContextHistoryChart = memo(function MarketContextHistoryChart(props: Props) {
  const data = useMemo(() => mergeSeries(props), [props.flows, props.indiaVix]);
  return (
    /* A flex column so the plot fills whatever height the row is given rather than asserting its
       own: the card is now pinned to the same height as the flows card beside it, and a fixed
       plot height would either overflow that or leave dead space under the axis. */
    <GlassPanel className="flex min-h-0 flex-col p-5 border-white/10 bg-slate-900/60">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-cyan-300">Market Context History</span>
          <h3 className="mt-1 text-lg font-bold text-white">Institutional Flow &amp; India VIX</h3>
          <p className="mt-1 text-xs text-slate-400">Missing sessions stay as gaps; they are never forward-filled.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-bold">
          <span className={`rounded-full border px-2 py-1 ${props.indiaVix.available && !props.indiaVix.isStale ? "border-violet-500/40 text-violet-300" : "border-amber-500/40 text-amber-300"}`}>
            VIX {props.indiaVix.available ? (props.indiaVix.isStale ? `STALE ${props.indiaVix.ageInDays ?? "?"}d` : "FRESH") : "NO DATA"}
          </span>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="mt-5 flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          No verified market-context history has been collected yet.
        </div>
      ) : (
        <div className="mt-5 min-h-0 w-full flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 5, left: 0 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.10)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 10 }} minTickGap={25} />
              <YAxis yAxisId="flow" tickFormatter={compactCrore} tick={{ fill: "#94a3b8", fontSize: 10 }} width={55} />
              <YAxis yAxisId="vix" orientation="right" domain={["auto", "auto"]} tick={{ fill: "#c4b5fd", fontSize: 10 }} width={34} />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid rgba(148,163,184,.25)", borderRadius: 10 }}
                labelStyle={{ color: "#e2e8f0" }}
                formatter={(value, name) => {
                  if (value === null || value === undefined) return ["No print", name];
                  if (name === "India VIX") return [Number(value).toFixed(2), name];
                  return [`₹${Number(value).toLocaleString("en-IN")} Cr`, name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine yAxisId="flow" y={0} stroke="rgba(148,163,184,.35)" />
              <Bar yAxisId="flow" dataKey="fii" name="FII net" fill="#fb7185" radius={[2, 2, 0, 0]} />
              <Bar yAxisId="flow" dataKey="dii" name="DII net" fill="#34d399" radius={[2, 2, 0, 0]} />
              <Line yAxisId="vix" type="monotone" dataKey="vix" name="India VIX" stroke="#a78bfa" strokeWidth={2} dot={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </GlassPanel>
  );
});
