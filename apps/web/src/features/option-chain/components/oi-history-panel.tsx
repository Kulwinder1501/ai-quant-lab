"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import {
  buildOiHistoryChart,
  contractKey,
  METRIC_LABELS,
  oiHistoryQuery,
  type ContractToken,
  type OiHistoryChartModel,
  type OiHistoryChartRow,
  type OiHistoryMetric,
  type OiHistoryMode,
  type OiHistoryPayload,
  type OptionSide,
} from "../build-oi-history-chart";
import { compactUnits, formatIstTime, istDateKey, oiAxisFormatter, signedCompact } from "../oi-format";
import { markerRenderer } from "./chart-markers";
import { SnapshotFreshnessBar } from "./snapshot-freshness-bar";

const MAX_CONTRACTS = 8;
const METRICS: readonly OiHistoryMetric[] = ["level", "changeVsPreviousClose", "changeVsPreviousSnapshot"];
const SPOT_COLOR = "#94a3b8";

interface LoadedState {
  key: string;
  payload: OiHistoryPayload | null;
  error: string | null;
}

/**
 * The shaded span for a collection gap. Drawn through `shape` because this Recharts version types
 * `ReferenceArea` styling props out; the span marks time with no snapshot, where the lines are cut.
 */
function gapShape(props: { x?: number; y?: number; width?: number; height?: number }): React.ReactElement<SVGElement> {
  return (
    <rect
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      fill="rgba(251,191,36,0.10)"
      stroke="rgba(251,191,36,0.35)"
      strokeDasharray="3 3"
    />
  );
}

function formatValue(value: number | null, metric: OiHistoryMetric): string {
  return metric === "level" ? compactUnits(value) : signedCompact(value);
}

function HistoryTooltip({
  active,
  payload,
  model,
  metric,
  showUnderlying,
}: {
  active?: boolean;
  payload?: Array<{ payload: OiHistoryChartRow }>;
  model: OiHistoryChartModel;
  metric: OiHistoryMetric;
  showUnderlying: boolean;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  if (row.isGapBreak) {
    return (
      <div className="rounded-lg border border-amber-400/40 bg-slate-950/95 px-3 py-2 text-xs text-amber-100 shadow-xl">
        No snapshot was collected in this interval. The lines are cut, not interpolated.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">{formatIstTime(row.t)} IST</p>
      <p className="text-slate-400">{METRIC_LABELS[metric]} · units, not lots</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {model.series.map((series) => (
          <React.Fragment key={series.key}>
            <span style={{ color: series.color }}>
              {series.side === "call" ? "●" : "■"} {series.label}
            </span>
            <span>{formatValue(row.values[series.key] ?? null, metric)}</span>
          </React.Fragment>
        ))}
        {row.putCallRatio !== null && (
          <>
            <span className="text-slate-400">Put/call ratio</span>
            <span>{row.putCallRatio.toFixed(3)}</span>
          </>
        )}
        {showUnderlying && (
          <>
            <span className="text-slate-400">Underlying (snapshot)</span>
            <span>{row.underlying === null ? "—" : row.underlying.toFixed(2)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
            value === option.id ? "bg-violet-500/20 text-violet-200" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Open interest across one session, from stored snapshots.
 *
 * Reads only the stored series: nothing here merges live ticks, so every point shares the snapshot
 * clock. Totals are over a fixed strike set (the stored window slides with ATM), the pre-open
 * snapshot is omitted because it repeats the previous close, and collection gaps cut the lines.
 */
export function OiHistoryPanel({ underlying, expiry, nowMs }: { underlying: string; expiry: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [mode, setMode] = useState<OiHistoryMode>("totals");
  const [metric, setMetric] = useState<OiHistoryMetric>("level");
  const [showUnderlying, setShowUnderlying] = useState(true);
  /** Null means "let the server choose"; once the user edits it holds the explicit selection. */
  const [customContracts, setCustomContracts] = useState<ContractToken[] | null>(null);
  const [addStrike, setAddStrike] = useState("");
  const [addSide, setAddSide] = useState<OptionSide>("CE");
  const [loaded, setLoaded] = useState<LoadedState | null>(null);

  const query = oiHistoryQuery({ underlying, expiry, sessionDate, contracts: customContracts });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/option-chain/oi-history?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `OI history request failed (${response.status}).`);
        }
        const body = await response.json() as { data: OiHistoryPayload };
        setLoaded({ key: query, payload: body.data, error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setLoaded({ key: query, payload: null, error: errorMessage(caught, "OI history could not be loaded.") });
      }
    })();
    return () => controller.abort();
  }, [query]);

  /** True until the response for the *current* selection arrives, so a stale chart is never shown as current. */
  const loading = loaded === null || loaded.key !== query;
  const payload = loaded?.payload ?? null;
  const available = payload !== null && payload.available ? payload : null;

  const model = useMemo(
    () => (available ? buildOiHistoryChart(available, { mode, metric }) : null),
    [available, mode, metric],
  );

  /** One stable marker element per series: a renderer built inline would remount every dot on each render. */
  const markers = useMemo(
    () => Object.fromEntries(
      (model?.series ?? []).map((series) => [
        series.key,
        React.createElement(markerRenderer(series.side === "call" ? "circle" : "square", series.color)),
      ]),
    ),
    [model],
  );

  const sessions = payload?.availableSessions ?? [];
  const effectiveContracts: ContractToken[] = customContracts
    ?? (available ? available.contracts.map((c) => ({ strikePrice: c.strikePrice, optionType: c.optionType })) : []);

  const lastObservation = available ? available.observations[available.observations.length - 1] : undefined;
  const totals = available && available.totals !== null && !("unavailable" in available.totals) ? available.totals : null;

  const addContract = (): void => {
    const strikePrice = Number(addStrike || available?.selectableStrikes[0]);
    if (!Number.isFinite(strikePrice) || effectiveContracts.length >= MAX_CONTRACTS) return;
    if (effectiveContracts.some((c) => c.strikePrice === strikePrice && c.optionType === addSide)) return;
    setCustomContracts([...effectiveContracts, { strikePrice, optionType: addSide }]);
  };

  return (
    <div className="w-full" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Session
          <select
            value={sessionDate}
            onChange={(event) => { setSessionDate(event.target.value); setCustomContracts(null); }}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">Latest</option>
            {sessions.map((session) => (
              <option key={session.sessionDate} value={session.sessionDate}>
                {session.sessionDate} · {session.snapshotCount} snapshots{session.snapshotCount < 10 ? " (partial)" : ""}
              </option>
            ))}
          </select>
        </label>
        <ToggleGroup
          label="Series"
          value={mode}
          onChange={setMode}
          options={[{ id: "totals", label: "Totals" }, { id: "contracts", label: "Strikes" }]}
        />
        <ToggleGroup
          label="Metric"
          value={metric}
          onChange={setMetric}
          options={METRICS.map((id) => ({ id, label: METRIC_LABELS[id] }))}
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={showUnderlying} onChange={(event) => setShowUnderlying(event.target.checked)} />
          Underlying
        </label>
      </div>

      {mode === "contracts" && available && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {effectiveContracts.map((contract, index) => (
            <span
              key={contractKey(contract.strikePrice, contract.optionType)}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
            >
              {contract.optionType === "CE" ? "●" : "■"} {contract.strikePrice} {contract.optionType}
              <button
                type="button"
                aria-label={`Remove ${contract.strikePrice} ${contract.optionType}`}
                disabled={effectiveContracts.length <= 1}
                onClick={() => setCustomContracts(effectiveContracts.filter((_, i) => i !== index))}
                className="ml-1 text-slate-400 hover:text-white disabled:opacity-30"
              >
                ×
              </button>
            </span>
          ))}
          {effectiveContracts.length < MAX_CONTRACTS && (
            <>
              <select
                aria-label="Strike to add"
                value={addStrike}
                onChange={(event) => setAddStrike(event.target.value)}
                className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
              >
                <option value="">Add strike…</option>
                {available.selectableStrikes.map((strike) => (
                  <option key={strike} value={strike}>{strike}</option>
                ))}
              </select>
              <select
                aria-label="Side to add"
                value={addSide}
                onChange={(event) => setAddSide(event.target.value as OptionSide)}
                className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
              >
                <option value="CE">CE</option>
                <option value="PE">PE</option>
              </select>
              <button
                type="button"
                onClick={addContract}
                disabled={addStrike === ""}
                className="rounded-lg border border-white/10 bg-violet-500/20 px-2 py-1 text-xs font-bold text-violet-200 disabled:opacity-40"
              >
                Add
              </button>
            </>
          )}
          <span className="text-[11px] text-slate-500">
            Up to {MAX_CONTRACTS}. Default: ATM and the heaviest-OI call and put — where positions sit, not a level price must respect.
          </span>
        </div>
      )}

      {loading && <p className="mb-2 text-xs text-slate-400">Loading…</p>}
      {loaded?.error && <p className="mb-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{loaded.error}</p>}
      {payload && !payload.available && (
        <p className="mb-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">{payload.reason}</p>
      )}

      {available && (
        <>
          <SnapshotFreshnessBar
            observedAt={lastObservation?.observedAt}
            expiryLabel={available.expiryDate}
            nowMs={nowMs}
            historical={available.sessionDate !== istDateKey(nowMs)}
          />
          <p className="mb-2 text-[11px] text-slate-400">
            Session {available.sessionDate} IST · {available.observations.length} intraday snapshots
            {available.preOpen ? ` · pre-open ${formatIstTime(Date.parse(available.preOpen.observedAt))} snapshot omitted: it repeats the previous close` : ""}
          </p>
          {available.collectionGaps.length > 0 && (
            <p className="mb-2 text-[11px] text-amber-200/90">
              {available.collectionGaps.length} collection gap{available.collectionGaps.length > 1 ? "s" : ""} (shaded; lines are cut, not interpolated):{" "}
              {available.collectionGaps
                .map((gap) => `${gap.minutes}m after ${formatIstTime(Date.parse(gap.from))}`)
                .join(" · ")}
            </p>
          )}
          {metric === "changeVsPreviousClose" && (
            <p className="mb-2 text-[11px] text-slate-500">
              Δ vs prev. close is the exchange&apos;s day-over-day baseline, not an intraday change. Use Δ vs previous snapshot for the move since the last collection.
            </p>
          )}
          {metric === "changeVsPreviousSnapshot" && available.collectionGaps.length > 0 && (
            <p className="mb-2 text-[11px] text-slate-500">
              Across a shaded gap the change spans a longer interval (about 30 minutes instead of 12–18), so it is not comparable with its neighbours.
            </p>
          )}
          {mode === "totals" && totals && (
            <p className="mb-2 text-[11px] text-slate-500">
              Fixed strike set: {totals.strikesUsed.length} strikes ({totals.strikesUsed[0]}–{totals.strikesUsed[totals.strikesUsed.length - 1]}), {totals.strikesExcluded} seen that session left out. {totals.rule}
            </p>
          )}

          {model?.emptyReason ? (
            <div className="rounded-xl border border-white/10 bg-slate-950/40 p-6 text-sm text-slate-400">{model.emptyReason}</div>
          ) : model ? (
            <div className="h-[380px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={model.rows} margin={{ top: 12, right: showUnderlying ? 8 : 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value: number) => formatIstTime(value)}
                    tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                  />
                  <YAxis
                    yAxisId="oi"
                    tickFormatter={oiAxisFormatter(model.maxAbs, model.signed)}
                    tick={{ fill: "rgba(148,163,184,0.9)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    label={{ value: model.yAxisLabel, angle: -90, position: "insideLeft", style: { fill: "rgba(148,163,184,0.7)", fontSize: 10 } }}
                  />
                  {showUnderlying && (
                    <YAxis
                      yAxisId="spot"
                      orientation="right"
                      domain={["auto", "auto"]}
                      tickFormatter={(value: number) => value.toFixed(0)}
                      tick={{ fill: SPOT_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                  )}
                  <Tooltip
                    cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                    content={<HistoryTooltip model={model} metric={metric} showUnderlying={showUnderlying} />}
                  />
                  <Legend formatter={(value: string) => <span className="text-xs text-slate-300">{value}</span>} />
                  {model.signed && <ReferenceLine yAxisId="oi" y={0} stroke="rgba(255,255,255,0.35)" />}
                  {model.gapAreas.map((gap) => (
                    <ReferenceArea
                      key={`${gap.x1}-${gap.x2}`}
                      yAxisId="oi"
                      x1={gap.x1}
                      x2={gap.x2}
                      shape={gapShape}
                    />
                  ))}
                  {model.baselines.map((baseline) => (
                    <ReferenceLine
                      key={baseline.label}
                      yAxisId="oi"
                      y={baseline.value}
                      stroke={baseline.color}
                      strokeDasharray="2 4"
                      label={{ value: baseline.label, fill: baseline.color, fontSize: 10, position: "insideTopLeft" }}
                    />
                  ))}
                  {model.series.map((series) => (
                    <Line
                      key={series.key}
                      yAxisId="oi"
                      type="linear"
                      dataKey={(row: OiHistoryChartRow) => row.values[series.key] ?? null}
                      name={`${series.label} ${series.side === "call" ? "(solid, circles)" : "(dashed, squares)"}`}
                      stroke={series.color}
                      strokeWidth={2}
                      strokeDasharray={series.side === "put" ? "6 3" : undefined}
                      dot={markers[series.key]}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                  {showUnderlying && (
                    <Line
                      yAxisId="spot"
                      type="linear"
                      dataKey="underlying"
                      name="Underlying (snapshot spot, right axis)"
                      stroke={SPOT_COLOR}
                      strokeWidth={1}
                      strokeDasharray="1 3"
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: open-interest change does not reveal who opened or closed a position, and a heavy-OI strike is not support or resistance. Stored snapshots stamp receipt time, not exchange time.
          </p>
        </>
      )}
    </div>
  );
}
