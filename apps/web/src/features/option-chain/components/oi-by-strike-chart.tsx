"use client";

import React, { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildOiByStrike,
  OI_CHANGE_BASELINE_LABEL,
  type OiByStrikePoint,
  type OiChangeSign,
  type OiStrikeInput,
} from "../build-oi-by-strike";
import { SnapshotFreshnessBar } from "./snapshot-freshness-bar";

export interface OiByStrikeChartProps {
  strikes: readonly OiStrikeInput[];
  atmStrike: number | null;
  underlyingValue: number | null;
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  /** Half-width in strike count around ATM (or median if ATM missing). Default 12. */
  window?: number;
  /** Clock for age/stale — pass from a parent timer so render stays pure. */
  nowMs: number;
}

function compactUnits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

function signedCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${compactUnits(value)}`;
}

function pctLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeWord(sign: OiChangeSign): string {
  switch (sign) {
    case "up":
      return "up vs prev. close";
    case "down":
      return "down vs prev. close";
    case "flat":
      return "unchanged vs prev. close";
    case "missing":
      return "missing";
  }
}

function fillForSign(side: "call" | "put", sign: OiChangeSign): string {
  if (sign === "missing") return side === "call" ? "rgba(148,163,184,0.35)" : "rgba(148,163,184,0.25)";
  if (sign === "up") return side === "call" ? "#34d399" : "#f472b6";
  if (sign === "down") return side === "call" ? "url(#oiCallDownHatch)" : "url(#oiPutDownHatch)";
  return side === "call" ? "#22d3ee" : "#c084fc";
}

function OiTooltip({
  active,
  payload,
  unitLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: OiByStrikePoint }>;
  unitLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">Strike {point.strike}</p>
      <p className="mt-1 text-slate-400">Unit: {unitLabel}</p>
      <p className="text-slate-400">{OI_CHANGE_BASELINE_LABEL}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-emerald-300">Call OI</span>
        <span>{compactUnits(point.callOi)}</span>
        <span className="text-emerald-300/80">Call {OI_CHANGE_BASELINE_LABEL}</span>
        <span>
          {signedCompact(point.callOiChange)} ({pctLabel(point.callOiChangePct)}) ·{" "}
          {changeWord(point.callChangeSign)}
        </span>
        <span className="text-fuchsia-300">Put OI</span>
        <span>{compactUnits(point.putOi)}</span>
        <span className="text-fuchsia-300/80">Put {OI_CHANGE_BASELINE_LABEL}</span>
        <span>
          {signedCompact(point.putOiChange)} ({pctLabel(point.putOiChangePct)}) ·{" "}
          {changeWord(point.putChangeSign)}
        </span>
      </div>
    </div>
  );
}

/**
 * Presentational OI chart. Fetches nothing — parent passes the same chain payload the tables use.
 */
export function OiByStrikeChart({
  strikes,
  atmStrike,
  underlyingValue,
  observedAt,
  provider,
  expiryLabel,
  window = 12,
  nowMs,
}: OiByStrikeChartProps) {
  const built = useMemo(
    () => buildOiByStrike(strikes, { atmStrike, window }),
    [strikes, atmStrike, window],
  );

  if (built.points.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-950/40 p-6 text-sm text-slate-400">
        No strikes in the selected window to chart.
      </div>
    );
  }

  return (
    <div className="w-full">
      <SnapshotFreshnessBar
        observedAt={observedAt}
        provider={provider}
        expiryLabel={expiryLabel}
        nowMs={nowMs}
      />
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-white">
          Open interest by strike
          <span className="ml-2 text-xs font-normal text-slate-400">
            Calls up · puts down · {OI_CHANGE_BASELINE_LABEL} (solid = up, hatch = down)
          </span>
        </p>
        <p className="text-[11px] text-slate-500">Y-axis: {built.unitLabel}</p>
      </div>
      {built.windowCenter === "median" && (
        <p className="mb-2 text-[11px] text-amber-200/90">
          ATM strike missing — window ±{built.windowApplied} centred on the median strike of this chain.
        </p>
      )}
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={built.points}
            stackOffset="sign"
            margin={{ top: 12, right: 16, left: 8, bottom: 8 }}
          >
            <defs>
              <pattern
                id="oiCallDownHatch"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="#059669" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#a7f3d0" strokeWidth="2" />
              </pattern>
              <pattern
                id="oiPutDownHatch"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="#9d174d" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#fbcfe8" strokeWidth="2" />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            />
            <YAxis
              tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => compactUnits(value)}
              label={{
                value: built.unitLabel,
                angle: -90,
                position: "insideLeft",
                style: { fill: "rgba(148,163,184,0.7)", fontSize: 10 },
              }}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={<OiTooltip unitLabel={built.unitLabel} />}
            />
            <Legend
              formatter={(value: string) => (
                <span className="text-xs text-slate-300">
                  {value === "callOiPlot"
                    ? `Call OI (${OI_CHANGE_BASELINE_LABEL})`
                    : `Put OI mirrored (${OI_CHANGE_BASELINE_LABEL})`}
                </span>
              )}
            />
            {(() => {
              // Categorical X only accepts values present in the series — snap markers to nearest strike.
              const nearest = (target: number | null): number | null => {
                if (target === null || !Number.isFinite(target) || built.points.length === 0) return null;
                let best = built.points[0]!.strike;
                let bestDistance = Math.abs(best - target);
                for (const point of built.points) {
                  const distance = Math.abs(point.strike - target);
                  if (distance < bestDistance) {
                    best = point.strike;
                    bestDistance = distance;
                  }
                }
                return best;
              };
              const atmMark = nearest(atmStrike);
              const spotMark = nearest(underlyingValue);
              return (
                <>
                  {atmMark !== null && (
                    <ReferenceLine
                      x={atmMark}
                      stroke="#fbbf24"
                      strokeDasharray="4 4"
                      label={{ value: "ATM", fill: "#fbbf24", fontSize: 10, position: "insideTopLeft" }}
                    />
                  )}
                  {spotMark !== null && spotMark !== atmMark && (
                    <ReferenceLine
                      x={spotMark}
                      stroke="#67e8f9"
                      strokeDasharray="2 3"
                      label={{
                        value: underlyingValue === null ? "Spot" : `Spot ${underlyingValue.toFixed(0)}`,
                        fill: "#67e8f9",
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />
                  )}
                </>
              );
            })()}
            <Bar
              dataKey="callOiPlot"
              name="callOiPlot"
              stackId="oi"
              maxBarSize={28}
              isAnimationActive={false}
            >
              {built.points.map((point) => (
                <Cell key={`call-${point.strike}`} fill={fillForSign("call", point.callChangeSign)} />
              ))}
            </Bar>
            <Bar
              dataKey="putOiPlot"
              name="putOiPlot"
              stackId="oi"
              maxBarSize={28}
              isAnimationActive={false}
            >
              {built.points.map((point) => (
                <Cell key={`put-${point.strike}`} fill={fillForSign("put", point.putChangeSign)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
