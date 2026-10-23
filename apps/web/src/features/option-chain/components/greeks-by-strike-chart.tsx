"use client";

import React, { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildGreeksByStrike,
  GREEKS_MODEL_DERIVED_LABEL,
  type GreeksByStrikePoint,
  type GreeksMetric,
  type GreeksStrikeInput,
} from "../build-greeks-by-strike";
import { SnapshotFreshnessBar } from "./snapshot-freshness-bar";

const METRICS: readonly { id: GreeksMetric; label: string }[] = [
  { id: "iv", label: "IV" },
  { id: "gamma", label: "Gamma" },
  { id: "theta", label: "Theta" },
  { id: "delta", label: "Delta" },
  { id: "vega", label: "Vega" },
];

export interface GreeksByStrikeChartProps {
  strikes: readonly GreeksStrikeInput[];
  atmStrike: number | null;
  underlyingValue: number | null;
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  window?: number;
  nowMs: number;
}

function formatMetric(value: number | null, metric: GreeksMetric): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (metric === "iv") return `${value.toFixed(2)}%`;
  if (metric === "delta" || metric === "gamma") return value.toFixed(4);
  return value.toFixed(2);
}

function GreeksTooltip({
  active,
  payload,
  metric,
  unitLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: GreeksByStrikePoint }>;
  metric: GreeksMetric;
  unitLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;
  const callRaw =
    metric === "iv"
      ? point.callIv === null
        ? null
        : point.callIv * 100
      : metric === "delta"
        ? point.callDelta
        : metric === "gamma"
          ? point.callGamma
          : metric === "theta"
            ? point.callTheta
            : point.callVega;
  const putRaw =
    metric === "iv"
      ? point.putIv === null
        ? null
        : point.putIv * 100
      : metric === "delta"
        ? point.putDelta
        : metric === "gamma"
          ? point.putGamma
          : metric === "theta"
            ? point.putTheta
            : point.putVega;

  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">Strike {point.strike}</p>
      <p className="mt-1 text-slate-400">{unitLabel}</p>
      <p className="text-amber-200/90">{GREEKS_MODEL_DERIVED_LABEL}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-emerald-300">Call</span>
        <span>
          {formatMetric(callRaw, metric)}
          {point.callIv === null && point.callIvRefusal
            ? ` · ${point.callIvRefusal}`
            : ""}
        </span>
        <span className="text-fuchsia-300">Put</span>
        <span>
          {formatMetric(putRaw, metric)}
          {point.putIv === null && point.putIvRefusal ? ` · ${point.putIvRefusal}` : ""}
        </span>
      </div>
    </div>
  );
}

export function GreeksByStrikeChart({
  strikes,
  atmStrike,
  underlyingValue,
  observedAt,
  provider,
  expiryLabel,
  window = 12,
  nowMs,
}: GreeksByStrikeChartProps) {
  const [metric, setMetric] = useState<GreeksMetric>("iv");
  const built = useMemo(
    () => buildGreeksByStrike(strikes, { metric, atmStrike, window }),
    [strikes, metric, atmStrike, window],
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100">
          {GREEKS_MODEL_DERIVED_LABEL}
        </span>
        <p className="text-[11px] text-slate-500">
          A Greek built from a stale mid is still stale — same snapshot clock as the OI tab.
        </p>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1">
          {METRICS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setMetric(entry.id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                metric === entry.id
                  ? "bg-violet-500/20 text-violet-200"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
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
              tickFormatter={(value: number) =>
                metric === "iv" ? `${value.toFixed(0)}%` : value.toFixed(metric === "gamma" || metric === "delta" ? 3 : 1)
              }
              label={{
                value: built.unitLabel,
                angle: -90,
                position: "insideLeft",
                style: { fill: "rgba(148,163,184,0.7)", fontSize: 10 },
              }}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={<GreeksTooltip metric={metric} unitLabel={built.unitLabel} />}
            />
            <Legend
              formatter={(value: string) => (
                <span className="text-xs text-slate-300">
                  {value === "callMetricPlot" ? `Call ${metric}` : `Put ${metric} (mirrored)`}
                </span>
              )}
            />
            {(() => {
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
              dataKey="callMetricPlot"
              name="callMetricPlot"
              stackId="greeks"
              fill="#34d399"
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey="putMetricPlot"
              name="putMetricPlot"
              stackId="greeks"
              fill="#f472b6"
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
