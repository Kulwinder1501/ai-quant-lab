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
import { describeImbalance, DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import {
  BUCKET_CHOICES,
  buildDepthHistoryChart,
  dataAgeSeconds,
  DEFAULT_BUCKET_SECONDS,
  depthHistoryQuery,
  formatIstClock,
  historyNotes,
  isIsolatedPoint,
  sessionOptionLabel,
  type DepthHistoryAvailable,
  type DepthHistoryChartModel,
  type DepthHistoryPayload,
  type DepthHistorySessionSummary,
  type HistoryChartRow,
} from "../depth-history-view";
import { formatIstTime } from "../oi-format";

/** A session still in progress is refetched this often. A finished session cannot change and is never refetched. */
const REFRESH_MS = 60_000;

const L5_COLOR = "#a78bfa";
const L1_COLOR = "#fbbf24";
const WHOLE_COLOR = "#38bdf8";
const SPREAD_COLOR = "#f472b6";
const MID_COLOR = "#94a3b8";

interface Loaded {
  key: string;
  payload: DepthHistoryPayload | null;
  fetchedAtMs: number | null;
  /** The last failure, kept beside the last good payload so a silent API never reads as current. */
  error: string | null;
}

/** The shaded span for a hole in the capture, drawn through `shape` as in the OI history. */
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

/** Hourly IST ticks across the session window: a fixed, readable axis for a day that may be only partly captured. */
function hourlyTicks(fromMs: number, toMs: number): number[] {
  const ticks: number[] = [];
  for (let at = fromMs; at <= toMs; at += 3_600_000) ticks.push(at);
  return ticks;
}

/**
 * Dots for points a line cannot reach. A sparse day, or a stray frame between two holes, would otherwise draw
 * nothing and read as an empty chart although data exists.
 */
function isolatedDots(
  rows: readonly HistoryChartRow[],
  pick: (row: HistoryChartRow) => number | null,
  color: string,
): (props: { cx?: number; cy?: number; index?: number }) => React.ReactElement<SVGElement> {
  return function IsolatedDot({ cx, cy, index }) {
    if (index === undefined || cx === undefined || cy === undefined || !isIsolatedPoint(rows, index, pick)) {
      return <g key={`dot-${index}`} />;
    }
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={3} fill={color} />;
  };
}

function intervalLabel(row: HistoryChartRow): string {
  if (row.bucketStart === null) return "";
  const start = formatIstClock(row.bucketStart);
  const end = formatIstClock(row.bucketStart + row.bucketSeconds * 1000);
  return `${start}–${end} IST`;
}

function ChartTooltip({
  active,
  payload,
  fields,
}: {
  active?: boolean;
  payload?: Array<{ payload: HistoryChartRow }>;
  fields: (row: HistoryChartRow) => Array<{ label: string; value: string; color: string }>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  if (row.isGapBreak) {
    return (
      <div className="rounded-lg border border-amber-400/40 bg-slate-950/95 px-3 py-2 text-xs text-amber-100 shadow-xl">
        No frames for {row.gapSeconds === null ? "a while" : `${Math.round(row.gapSeconds)} s`}. The lines are cut, not interpolated.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">{intervalLabel(row)}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {fields(row).map((field) => (
          <React.Fragment key={field.label}>
            <span style={{ color: field.color }}>{field.label}</span>
            <span>{field.value}</span>
          </React.Fragment>
        ))}
        <span className="text-slate-400">Frames</span>
        <span>{row.frames.toLocaleString("en-IN")} ({row.levelFrames.toLocaleString("en-IN")} with a usable book, {row.wholeBookFrames.toLocaleString("en-IN")} with whole-book totals)</span>
      </div>
    </div>
  );
}

function imbalanceText(value: number | null): string {
  const described = describeImbalance(value);
  return described.word === "not available" ? "—" : `${described.text} (${described.word})`;
}

function EmptyChart({ reason }: { reason: string }) {
  return <div className="rounded-xl border border-white/10 bg-slate-950/40 p-4 text-xs text-slate-400">{reason}</div>;
}

const AXIS_TICK = { fill: "rgba(148,163,184,0.9)", fontSize: 11 };

function SharedAxes({ domain, ticks, showTimeLabels }: { domain: [number, number]; ticks: number[]; showTimeLabels: boolean }) {
  return (
    <XAxis
      dataKey="t"
      type="number"
      scale="time"
      domain={domain}
      ticks={ticks}
      tickFormatter={(value: number) => formatIstTime(value)}
      tick={showTimeLabels ? AXIS_TICK : false}
      tickLine={false}
      axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
      height={showTimeLabels ? 24 : 6}
    />
  );
}

function GapAreas({ model }: { model: DepthHistoryChartModel }) {
  return (
    <>
      {model.gapAreas.map((gap) => (
        <ReferenceArea key={`${gap.x1}-${gap.x2}`} x1={gap.x1} x2={gap.x2} shape={gapShape} />
      ))}
    </>
  );
}

/**
 * The stored order book across one trading day: imbalance, spread and mid, from `depth_frames`.
 *
 * Frames are the collector's, summarised in buckets by the API with the same rules as the ladder. A hole in the
 * capture cuts the lines, a bucket with no usable frame is a break rather than a zero, and the frames that were
 * left out are counted beside the chart. Resting quantity, not traded volume; the level imbalances are top of the
 * book only. A session still being written refreshes every minute and says how old its data is.
 */
export function DepthHistoryPanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [bucketSeconds, setBucketSeconds] = useState(DEFAULT_BUCKET_SECONDS);
  const [show, setShow] = useState({ l1: false, l5: true, whole: true });
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** The newest session list seen, so the drop-down survives an unavailable day that still carries it. */
  const [sessions, setSessions] = useState<DepthHistorySessionSummary[]>([]);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = depthHistoryQuery({ underlying, sessionDate, bucketSeconds });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/depth/history?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Depth history request failed (${response.status}).`);
        }
        const body = await response.json() as { data: DepthHistoryPayload };
        if (body.data.availableSessions) setSessions(body.data.availableSessions);
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "Depth history could not be loaded.");
        // A failed refresh keeps the last good payload of the same selection, with its true age and the failure.
        setLoaded((previous) => (
          previous !== null && previous.key === query && previous.payload !== null
            ? { ...previous, error: message }
            : { key: query, payload: null, fetchedAtMs: null, error: message }
        ));
      }
    })();
    return () => controller.abort();
  }, [query, refreshTick, supported]);

  const payload = loaded?.key === query ? loaded.payload : null;
  const available: DepthHistoryAvailable | null = payload !== null && payload.available ? payload : null;
  const refreshing = available?.inProgress === true;

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  const loading = supported && (loaded === null || loaded.key !== query);
  /** A failure belongs to the selection that raised it: never shown beside a different, still-loading one. */
  const failure = loaded?.key === query ? loaded.error : null;
  const model = useMemo(() => (available ? buildDepthHistoryChart(available) : null), [available]);
  const notes = useMemo(() => (available ? historyNotes(available) : []), [available]);

  if (!supported) {
    return (
      <p className="rounded-xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-300">
        Depth is stored for {DEPTH_UNDERLYINGS.join(" and ")} index futures only. {underlying} has no stored order book.
      </p>
    );
  }

  const domain: [number, number] | null = available
    ? [Date.parse(available.window.from), Date.parse(available.window.to)]
    : null;
  const ticks = domain ? hourlyTicks(domain[0], domain[1]) : [];
  const chartMargin = { top: 8, right: 16, left: 8, bottom: 4 };
  const ageSeconds = loaded?.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;
  /** What would actually draw: a selected line whose data the API had to withhold draws nothing, and says why. */
  const levelPlot = model !== null && model.emptyReason.imbalance === null && (show.l5 || show.l1);
  const wholePlot = model !== null && model.emptyReason.wholeBook === null && show.whole;
  const imbalanceEmptyReason = !show.l5 && !show.l1 && !show.whole
    ? "No line is selected."
    : [
        (show.l5 || show.l1) ? model?.emptyReason.imbalance : null,
        show.whole ? model?.emptyReason.wholeBook : null,
      ].filter(Boolean).join(" ");

  return (
    <div className="w-full" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Session
          <select
            value={sessionDate}
            onChange={(event) => setSessionDate(event.target.value)}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">Latest</option>
            {sessions.map((session) => (
              <option key={session.sessionDate} value={session.sessionDate}>{sessionOptionLabel(session)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Bucket
          <select
            value={bucketSeconds}
            onChange={(event) => setBucketSeconds(Number(event.target.value))}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            {BUCKET_CHOICES.map((choice) => <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>)}
          </select>
        </label>
        <fieldset className="flex items-center gap-3 text-xs text-slate-400">
          <legend className="sr-only">Imbalance lines</legend>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={show.l5} onChange={(e) => setShow({ ...show, l5: e.target.checked })} />Levels 1–5</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={show.l1} onChange={(e) => setShow({ ...show, l1: e.target.checked })} />Touch only</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={show.whole} onChange={(e) => setShow({ ...show, whole: e.target.checked })} />Whole book</label>
        </fieldset>
      </div>

      {loading && <p className="mb-2 text-xs text-slate-400">Loading… a full session takes about two seconds.</p>}
      {failure && (
        <p className="mb-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {failure}{available && ageSeconds !== null ? `${/[.!?]$/.test(failure) ? "" : "."} Showing the data fetched ${ageSeconds} s ago.` : ""}
        </p>
      )}
      {payload && !payload.available && (
        <p className="mb-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">{payload.reason}</p>
      )}

      {available && model && domain && (
        <>
          <p className="mb-1 text-[11px] text-slate-400">
            {available.underlying} futures {available.contract.providerSymbol}
            {available.contract.expiryDate ? ` (expiry ${available.contract.expiryDate})` : ""} · session {available.sessionDate} IST ·{" "}
            {available.counts.framesInSession.toLocaleString("en-IN")} frames in {available.buckets.length} buckets of {available.bucketSeconds} s
            {available.inProgress && ageSeconds !== null ? ` · session in progress, fetched ${ageSeconds} s ago, refreshed every minute` : ""}
          </p>
          {available.gaps.length > 0 && (
            <p className="mb-1 text-[11px] text-amber-200/90">
              {available.gaps.length} hole{available.gaps.length > 1 ? "s" : ""} in the capture (shaded; lines are cut, not interpolated):{" "}
              {available.gaps.map((gap) => `${Math.round(gap.seconds)} s after ${formatIstClock(Date.parse(gap.from))}`).join(" · ")}
            </p>
          )}
          {notes.map((note) => (
            <p key={note.text} className={`mb-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
          ))}

          <h4 className="mt-3 text-xs font-bold text-slate-200">Imbalance, (bid − ask) / (bid + ask)</h4>
          {!levelPlot && !wholePlot
            ? <EmptyChart reason={imbalanceEmptyReason} />
            : (
              <div className="h-[220px] w-full" role="img" aria-label="Order-book imbalance across the session, one line per measure">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={model.rows} margin={chartMargin} syncId="depth-history">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <SharedAxes domain={domain} ticks={ticks} showTimeLabels={false} />
                    <YAxis
                      domain={[-1, 1]}
                      ticks={[-1, -0.5, 0, 0.5, 1]}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={36}
                    />
                    <Tooltip
                      cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                      content={(
                        <ChartTooltip
                          fields={(row) => [
                            ...(show.l5 ? [{ label: "Levels 1–5", value: imbalanceText(row.imbalanceL5), color: L5_COLOR }] : []),
                            ...(show.l1 ? [{ label: "Touch only", value: imbalanceText(row.imbalanceL1), color: L1_COLOR }] : []),
                            ...(show.whole ? [{ label: "Whole book", value: imbalanceText(row.imbalanceWholeBook), color: WHOLE_COLOR }] : []),
                          ]}
                        />
                      )}
                    />
                    <Legend formatter={(value: string) => <span className="text-xs text-slate-300">{value}</span>} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" />
                    <GapAreas model={model} />
                    {show.l5 && levelPlot && (
                      <Line type="linear" dataKey="imbalanceL5" name="Levels 1–5 (solid)" stroke={L5_COLOR} strokeWidth={2} dot={isolatedDots(model.rows, (r) => r.imbalanceL5, L5_COLOR)} connectNulls={false} isAnimationActive={false} />
                    )}
                    {show.l1 && levelPlot && (
                      <Line type="linear" dataKey="imbalanceL1" name="Touch only (dotted)" stroke={L1_COLOR} strokeWidth={1} strokeDasharray="1 3" dot={isolatedDots(model.rows, (r) => r.imbalanceL1, L1_COLOR)} connectNulls={false} isAnimationActive={false} />
                    )}
                    {wholePlot && (
                      <Line type="linear" dataKey="imbalanceWholeBook" name="Whole book (dashed)" stroke={WHOLE_COLOR} strokeWidth={2} strokeDasharray="6 3" dot={isolatedDots(model.rows, (r) => r.imbalanceWholeBook, WHOLE_COLOR)} connectNulls={false} isAnimationActive={false} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          {levelPlot === false && (show.l5 || show.l1) && wholePlot && <p className="mt-1 text-[11px] text-slate-500">Levels 1–5 and touch: {model.emptyReason.imbalance}</p>}
          {wholePlot === false && show.whole && levelPlot && <p className="mt-1 text-[11px] text-slate-500">Whole book: {model.emptyReason.wholeBook}</p>}
          <p className="mt-1 text-[11px] text-slate-500">
            Above zero is more resting quantity on the bid, below zero more on the ask. Levels 1–5 and the touch are the top of the book only: the ten stored levels reach a few points and hold about 2% of the whole book. The whole-book line uses the feed&apos;s own totals (all 50 levels). They can disagree, and none of them is a forecast.
          </p>

          <h4 className="mt-4 text-xs font-bold text-slate-200">Spread, index points</h4>
          {model.emptyReason.spread ? <EmptyChart reason={model.emptyReason.spread} /> : (
            <div className="h-[170px] w-full" role="img" aria-label="Bid-ask spread across the session">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={model.rows} margin={chartMargin} syncId="depth-history">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <SharedAxes domain={domain} ticks={ticks} showTimeLabels={false} />
                  <YAxis
                    domain={[0, Math.max(1, Math.ceil(model.spreadMax * 1.1))]}
                    tickFormatter={(value: number) => value.toFixed(0)}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                    content={(
                      <ChartTooltip
                        fields={(row) => [
                          { label: "Median spread", value: row.spreadMedian === null ? "—" : `${row.spreadMedian.toFixed(2)} pts`, color: SPREAD_COLOR },
                          { label: "Widest spread", value: row.spreadMax === null ? "—" : `${row.spreadMax.toFixed(2)} pts`, color: SPREAD_COLOR },
                        ]}
                      />
                    )}
                  />
                  <Legend formatter={(value: string) => <span className="text-xs text-slate-300">{value}</span>} />
                  <GapAreas model={model} />
                  <Line type="linear" dataKey="spreadMax" name="Widest in bucket (dotted)" stroke={SPREAD_COLOR} strokeWidth={1} strokeDasharray="1 3" dot={false} connectNulls={false} isAnimationActive={false} />
                  <Line type="linear" dataKey="spreadMedian" name="Median (solid)" stroke={SPREAD_COLOR} strokeWidth={2} dot={isolatedDots(model.rows, (r) => r.spreadMedian, SPREAD_COLOR)} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          <h4 className="mt-4 text-xs font-bold text-slate-200">Mid price, median of (best bid + best ask) / 2</h4>
          {model.emptyReason.mid ? <EmptyChart reason={model.emptyReason.mid} /> : (
            <div className="h-[150px] w-full" role="img" aria-label="Mid price of the futures contract across the session">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={model.rows} margin={chartMargin} syncId="depth-history">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <SharedAxes domain={domain} ticks={ticks} showTimeLabels />
                  <YAxis
                    domain={["auto", "auto"]}
                    tickFormatter={(value: number) => value.toFixed(0)}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                    content={<ChartTooltip fields={(row) => [{ label: "Mid", value: row.mid === null ? "—" : row.mid.toFixed(2), color: MID_COLOR }]} />}
                  />
                  <GapAreas model={model} />
                  <Line type="linear" dataKey="mid" name="Mid" stroke={MID_COLOR} strokeWidth={1.5} dot={isolatedDots(model.rows, (r) => r.mid, MID_COLOR)} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-500">All three charts share one time axis (IST); hover any of them to read the same moment on the others.</p>

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and provenance</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(available.definitions).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{available.source}. Frames are stamped with our receive time, not the exchange&apos;s.</p>
            <p className="mt-1">
              Capture sessions:{" "}
              {available.captureSessions
                .map((span) => `${span.captureSessionId.slice(0, 8)} (${span.frames.toLocaleString("en-IN")} frames, ${formatIstClock(Date.parse(span.firstAt))}–${formatIstClock(Date.parse(span.lastAt))})`)
                .join(" · ")}
            </p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: resting quantity is not traded quantity, a large resting order can be pulled before it trades, and an imbalance describes the book at that moment without forecasting price.
          </p>
        </>
      )}
    </div>
  );
}
