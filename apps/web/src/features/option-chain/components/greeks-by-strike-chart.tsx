"use client";

import React, { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildGreeksByStrike,
  formatGreekValue,
  GREEKS_MODEL_DERIVED_LABEL,
  GREEKS_PER_UNIT_NOTE,
  type GreeksByStrikePoint,
  type GreeksMetric,
  type GreeksStrikeInput,
  type UnsolvedSummary,
} from "../build-greeks-by-strike";
import { ivRefusalLabel } from "../iv-refusal-label";
import { DEFAULT_STRIKE_WINDOW, nearestStrikeOnAxis } from "../strike-axis";
import { PRE_OPEN_NOTE_QUOTES, SnapshotFreshnessBar } from "./snapshot-freshness-bar";

const METRICS: readonly { id: GreeksMetric; label: string }[] = [
  { id: "iv", label: "IV" },
  { id: "gamma", label: "Gamma" },
  { id: "theta", label: "Theta" },
  { id: "delta", label: "Delta" },
  { id: "vega", label: "Vega" },
];

/** Metrics whose sign carries meaning, so zero deserves a reference line. */
const SIGNED_METRICS: ReadonlySet<GreeksMetric> = new Set<GreeksMetric>(["theta", "delta"]);

const CALL_COLOR = "#34d399";
const PUT_COLOR = "#f472b6";

export interface GreeksByStrikeChartProps {
  /** Strikes priced from the stored snapshot only — never the tick-merged chain. */
  strikes: readonly GreeksStrikeInput[];
  atmStrike: number | null;
  /** Spot as of the snapshot, so the marker shares the clock of the Greeks. */
  underlyingValue: number | null;
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  window?: number;
  nowMs: number;
}

interface DotProps {
  cx?: number;
  cy?: number;
}

/**
 * Call = circle, put = square, so the two sides stay distinguishable without relying on colour.
 * A gap (null value) arrives without coordinates and renders nothing.
 */
function dotRenderer(shape: "circle" | "square", color: string) {
  function Dot({ cx, cy }: DotProps): React.ReactElement {
    if (typeof cx !== "number" || typeof cy !== "number" || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      return <g />;
    }
    return shape === "circle" ? (
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="#0f172a" strokeWidth={1} />
    ) : (
      <rect x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill={color} stroke="#0f172a" strokeWidth={1} />
    );
  }
  return Dot;
}

const CallDot = dotRenderer("circle", CALL_COLOR);
const PutDot = dotRenderer("square", PUT_COLOR);

function describeSide(label: string, side: UnsolvedSummary["calls"]): string {
  if (side.legs === 0) return `${label}: none in window`;
  if (side.unsolved === 0) return `${label}: all ${side.legs} solved`;
  const reasons = Object.entries(side.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason === "UNKNOWN" ? "unspecified" : ivRefusalLabel(reason)} ×${count}`)
    .join(", ");
  return `${label}: ${side.unsolved} of ${side.legs} unsolved (${reasons})`;
}

/**
 * Says how many contracts carry no Greeks and why. A line chart just breaks at an unsolved strike,
 * which a reader can mistake for a thin market; the count makes the thinning explicit.
 */
function UnsolvedSummaryLine({ summary }: { summary: UnsolvedSummary }) {
  const anyUnsolved = summary.calls.unsolved > 0 || summary.puts.unsolved > 0;
  return (
    <p className={`mb-2 text-[11px] ${anyUnsolved ? "text-amber-200/90" : "text-slate-500"}`}>
      IV solved from the mid, so unsolved contracts show no Greeks (a gap, not zero) — {describeSide("calls", summary.calls)} ·{" "}
      {describeSide("puts", summary.puts)}
    </p>
  );
}

function sideText(
  present: boolean,
  value: number | null,
  refusal: string | null,
  metric: GreeksMetric,
  decimals: number,
): string {
  if (!present) return "no contract";
  if (value !== null) return formatGreekValue(value, metric, decimals);
  return `— (${ivRefusalLabel(refusal)})`;
}

function GreeksTooltip({
  active,
  payload,
  metric,
  unitLabel,
  decimals,
}: {
  active?: boolean;
  payload?: Array<{ payload: GreeksByStrikePoint }>;
  metric: GreeksMetric;
  unitLabel: string;
  decimals: number;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;

  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">Strike {point.strike}</p>
      <p className="mt-1 text-slate-400">{unitLabel}</p>
      <p className="text-amber-200/90">{GREEKS_MODEL_DERIVED_LABEL}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-emerald-300">Call ●</span>
        <span>{sideText(point.callPresent, point.callMetricPlot, point.callIvRefusal, metric, decimals)}</span>
        <span className="text-fuchsia-300">Put ■</span>
        <span>{sideText(point.putPresent, point.putMetricPlot, point.putIvRefusal, metric, decimals)}</span>
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
  window = DEFAULT_STRIKE_WINDOW,
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

  const axisStrikes = built.points.map((point) => point.strike);
  const atmMark = nearestStrikeOnAxis(axisStrikes, atmStrike);
  const spotMark = nearestStrikeOnAxis(axisStrikes, underlyingValue);

  return (
    <div className="w-full">
      <SnapshotFreshnessBar
        observedAt={observedAt}
        provider={provider}
        expiryLabel={expiryLabel}
        nowMs={nowMs}
        preOpenNote={PRE_OPEN_NOTE_QUOTES}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100">
          {GREEKS_MODEL_DERIVED_LABEL}
        </span>
        <p className="text-[11px] text-slate-500">
          Priced from the stored snapshot only. Live ticks are not merged, so every strike shares one clock.
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
      {(metric === "theta" || metric === "vega") && (
        <p className="mb-2 text-[11px] text-slate-500">{GREEKS_PER_UNIT_NOTE}</p>
      )}
      <UnsolvedSummaryLine summary={built.unsolved} />
      {built.windowCenter === "median" && (
        <p className="mb-2 text-[11px] text-amber-200/90">
          ATM strike missing — window ±{built.windowApplied} centred on the median strike of this chain.
        </p>
      )}
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={built.points} margin={{ top: 12, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            />
            <YAxis
              // IV lives in a narrow band (a smile); anchoring it at zero would flatten the shape.
              domain={metric === "iv" ? ["auto", "auto"] : undefined}
              tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatGreekValue(value, metric, built.axisDecimals)}
              width={72}
              label={{
                value: built.unitLabel,
                angle: -90,
                position: "insideLeft",
                style: { fill: "rgba(148,163,184,0.7)", fontSize: 10 },
              }}
            />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,0.15)" }}
              content={
                <GreeksTooltip metric={metric} unitLabel={built.unitLabel} decimals={built.axisDecimals} />
              }
            />
            <Legend
              formatter={(value: string) => (
                <span className="text-xs text-slate-300">
                  {value === "callMetricPlot" ? "Call (solid, circles)" : "Put (dashed, squares)"}
                </span>
              )}
            />
            {SIGNED_METRICS.has(metric) && (
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" />
            )}
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
                  value: underlyingValue === null ? "Spot" : `Spot ${underlyingValue.toFixed(0)} (snapshot)`,
                  fill: "#67e8f9",
                  fontSize: 10,
                  position: "insideTopRight",
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="callMetricPlot"
              name="callMetricPlot"
              stroke={CALL_COLOR}
              strokeWidth={2}
              dot={<CallDot />}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="putMetricPlot"
              name="putMetricPlot"
              stroke={PUT_COLOR}
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={<PutDot />}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
