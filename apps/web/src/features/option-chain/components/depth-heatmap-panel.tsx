"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import { dataAgeSeconds, formatIstClock } from "../depth-history-view";
import {
  bucketAtFraction,
  buildHeatmapGeometry,
  cellFill,
  cellKey,
  DEFAULT_HEATMAP_COLUMN_SECONDS,
  DEFAULT_HEATMAP_ROW_POINTS,
  describeCell,
  HEATMAP_COLUMN_CHOICES,
  HEATMAP_ROW_CHOICES,
  heatmapQuery,
  heatmapSessionLabel,
  playbackInstant,
  rowAtFraction,
  scaleSentence,
  type DepthHeatmapAvailable,
  type DepthHeatmapPayload,
  type HeatmapCell,
  type HeatmapGeometry,
} from "../depth-heatmap-view";
import { formatIstTime } from "../oi-format";
import { DepthLadderPanel } from "./depth-ladder-panel";

/** A session still in progress is refetched this often. A finished one cannot change and is never refetched. */
const REFRESH_MS = 60_000;
const SPEEDS: ReadonlyArray<{ columnsPerSecond: number; label: string }> = [
  { columnsPerSecond: 1, label: "1 column/s" },
  { columnsPerSecond: 3, label: "3 columns/s" },
  { columnsPerSecond: 10, label: "10 columns/s" },
];

/** SVG user-space layout: the picture scales to the width of its container. */
const W = 1000;
const MARGIN = { left: 60, right: 12, top: 8, bottom: 22 };
const PLOT_W = W - MARGIN.left - MARGIN.right;

interface Loaded {
  key: string;
  payload: DepthHeatmapPayload | null;
  fetchedAtMs: number | null;
  error: string | null;
}

/** Connected runs of the mid, cut where a bucket has none or where columns are not adjacent (a hole in the capture). */
function midSegments(geometry: HeatmapGeometry): Array<Array<{ x: number; y: number }>> {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  let previousX: number | null = null;
  for (const point of geometry.midPoints) {
    const adjacent = previousX !== null && point.x - previousX <= geometry.columnWidth * 1.5;
    if (point.y === null || !adjacent) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    if (point.y !== null) current.push({ x: point.x, y: point.y });
    previousX = point.x;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function GradientKey({ side, label }: { side: "bid" | "ask"; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-20 rounded-sm border border-white/10"
        style={{ background: `linear-gradient(to right, ${cellFill(side, 0)}, ${cellFill(side, 1)})` }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/**
 * The stored order book across one trading day as a price-by-time grid of resting quantity, with playback.
 *
 * A price the stored levels did not reach is unknown and is not drawn; a price they covered with nothing resting is
 * drawn as a faint cell. Only the best ten levels a side are stored, so this is the top of the book. Columns sit at
 * their real time, so a hole in the capture is a hole in the picture. Playback steps the ladder through the day by
 * asking the API for the book as it stood when each column closed.
 */
export function DepthHeatmapPanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [bucketSeconds, setBucketSeconds] = useState(DEFAULT_HEATMAP_COLUMN_SECONDS);
  const [rowPoints, setRowPoints] = useState(DEFAULT_HEATMAP_ROW_POINTS);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sessions, setSessions] = useState<DepthHeatmapAvailable["availableSessions"]>([]);
  /**
   * Cursor, play state and hover text are tagged with the query they belong to, so a new grid (another session, column
   * size or row size) simply does not see them: no column that moved is pointed at, and nothing keeps playing.
   */
  const [cursorState, setCursorState] = useState<{ query: string; index: number } | null>(null);
  const [playingFor, setPlayingFor] = useState<string | null>(null);
  const [hover, setHover] = useState<{ query: string; text: string | null } | null>(null);
  const [speed, setSpeed] = useState(SPEEDS[0]!.columnsPerSecond);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = heatmapQuery({ underlying, sessionDate, bucketSeconds, rowPoints });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/depth/heatmap?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Heatmap request failed (${response.status}).`);
        }
        const body = await response.json() as { data: DepthHeatmapPayload };
        if (body.data.availableSessions) setSessions(body.data.availableSessions);
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "The heatmap could not be loaded.");
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
  const available: DepthHeatmapAvailable | null = payload !== null && payload.available ? payload : null;
  const refreshing = available?.inProgress === true;

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  const geometry = useMemo(() => (available ? buildHeatmapGeometry(available) : null), [available]);
  const lookup = useMemo(
    () => new Map<string, HeatmapCell>((available?.cells ?? []).map((cell) => [cellKey(cell[0], cell[1]), cell])),
    [available],
  );
  const lastColumn = available ? available.buckets.length - 1 : -1;
  const cursor = cursorState?.query === query ? cursorState.index : null;
  const hoverText = hover?.query === query ? hover.text : null;
  // Playing stops by itself on the last column: the interval below is torn down once this turns false.
  const playing = playingFor === query && lastColumn >= 0 && !(cursor !== null && cursor >= lastColumn);
  const setCursor = (update: (current: number | null) => number): void =>
    setCursorState((previous) => ({ query, index: update(previous?.query === query ? previous.index : null) }));
  const setPlaying = (on: boolean): void => setPlayingFor(on ? query : null);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      setCursorState((previous) => {
        const current = previous?.query === query ? previous.index : null;
        return { query, index: Math.min(lastColumn, (current ?? -1) + 1) };
      });
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, lastColumn, query]);

  /** The book to show: as it stood when the cursor's column closed, never later than now. */
  const asOf = useMemo(
    () => (available && cursor !== null && available.buckets[cursor]
      ? playbackInstant(available.buckets[cursor]!, available.bucketSeconds, nowMs)
      : null),
    [available, cursor, nowMs],
  );

  const bodies = useMemo(() => {
    if (!available || !geometry) return null;
    const plotH = Math.min(900, Math.max(300, geometry.rowCount * 3));
    const cellRects = geometry.cells.map((cell) => (
      <rect
        key={`${cell.bucketIndex}:${cell.row}`}
        x={MARGIN.left + cell.x * PLOT_W}
        y={MARGIN.top + cell.y * plotH}
        width={Math.max(cell.width * PLOT_W, 0.8) + 0.3}
        height={Math.max(cell.height * plotH, 0.6) + 0.3}
        fill={cellFill(cell.side, cell.intensity)}
        shapeRendering="crispEdges"
      />
    ));
    return { plotH, cellRects };
  }, [available, geometry]);

  if (!supported) {
    return (
      <p className="rounded-xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-300">
        Depth is stored for {DEPTH_UNDERLYINGS.join(" and ")} index futures only. {underlying} has no stored order book.
      </p>
    );
  }

  const loading = loaded === null || loaded.key !== query;
  const failure = loaded?.key === query ? loaded.error : null;
  const ageSeconds = loaded?.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;

  const pointer = (event: React.MouseEvent<SVGSVGElement>): { bucketIndex: number | null; row: number | null } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !available || !bodies) return { bucketIndex: null, row: null };
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const py = ((event.clientY - rect.top) / rect.height) * (MARGIN.top + bodies.plotH + MARGIN.bottom);
    const fx = (px - MARGIN.left) / PLOT_W;
    const fy = (py - MARGIN.top) / bodies.plotH;
    return {
      bucketIndex: fx < 0 || fx >= 1 ? null : bucketAtFraction(available, fx),
      row: rowAtFraction(available.rowRange, fy),
    };
  };

  const span = available ? Date.parse(available.window.to) - Date.parse(available.window.from) : 0;
  const hourTicks: number[] = [];
  if (available) {
    for (let at = Date.parse(available.window.from); at <= Date.parse(available.window.to); at += 3_600_000) hourTicks.push(at);
  }
  const priceTicks: Array<{ y: number; label: string }> = [];
  if (available && geometry && bodies && available.rowRange) {
    const { low, high } = available.rowRange;
    const step = Math.max(1, Math.round((high - low + 1) / 6));
    for (let row = high + 1; row >= low; row -= step) {
      priceTicks.push({
        y: MARGIN.top + ((high + 1 - row) / geometry.rowCount) * bodies.plotH,
        label: (row * available.rowPoints).toLocaleString("en-IN"),
      });
    }
  }
  const cursorBucket = available && cursor !== null ? available.buckets[cursor] : undefined;

  return (
    <div className="w-full" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Session
          <select value={sessionDate} onChange={(event) => setSessionDate(event.target.value)} className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200">
            <option value="">Latest</option>
            {sessions.map((session) => <option key={session.sessionDate} value={session.sessionDate}>{heatmapSessionLabel(session)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Columns
          <select value={bucketSeconds} onChange={(event) => setBucketSeconds(Number(event.target.value))} className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200">
            {HEATMAP_COLUMN_CHOICES.map((choice) => <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Rows
          <select value={rowPoints} onChange={(event) => setRowPoints(Number(event.target.value))} className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200">
            {HEATMAP_ROW_CHOICES.map((choice) => <option key={choice.points} value={choice.points}>{choice.label}</option>)}
          </select>
        </label>
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

      {available && geometry && bodies && (
        <>
          <p className="mb-1 text-[11px] text-slate-400">
            {available.underlying} futures {available.contract.providerSymbol}
            {available.contract.expiryDate ? ` (expiry ${available.contract.expiryDate})` : ""} · session {available.sessionDate} IST ·{" "}
            {available.counts.framesUsed.toLocaleString("en-IN")} of {available.counts.framesInSession.toLocaleString("en-IN")} frames used ·{" "}
            {available.buckets.length} columns of {available.bucketSeconds} s, rows of {available.rowPoints} pt{available.rowPoints > 1 ? "s" : ""} ·{" "}
            {available.storedLevels.min === available.storedLevels.max
              ? `${available.storedLevels.min} levels stored per frame`
              : `${available.storedLevels.min} to ${available.storedLevels.max} levels stored per frame (the collector was raised part-way, so depth differs across the day)`}
            {available.inProgress && ageSeconds !== null ? ` · session in progress, fetched ${ageSeconds} s ago, refreshed every minute` : ""}
          </p>
          {available.gaps.length > 0 && (
            <p className="mb-1 text-[11px] text-amber-200/90">
              {available.gaps.length} hole{available.gaps.length > 1 ? "s" : ""} in the capture (shaded, no cells drawn):{" "}
              {available.gaps.map((gap) => `${Math.round(gap.seconds)} s after ${formatIstClock(Date.parse(gap.from))}`).join(" · ")}
            </p>
          )}
          {available.concurrentWriters.map((pair) => (
            <p key={`${pair.a}-${pair.b}`} className="mb-1 text-[11px] text-amber-200">
              Two capture sessions were writing at once for {pair.overlapSeconds.toFixed(0)} s ({formatIstClock(Date.parse(pair.overlapFrom))}–{formatIstClock(Date.parse(pair.overlapTo))} IST): cells in that span mix two streams of the same contract.
            </p>
          ))}
          {available.counts.framesWithoutLevelMetrics > 0 && (
            <p className="mb-1 text-[11px] text-slate-500">
              {available.counts.framesWithoutLevelMetrics.toLocaleString("en-IN")} frames had a book that cannot be used level by level (crossed, out of order, or captured before 2026-09-07) and add nothing to the grid.
            </p>
          )}

          {geometry.cells.length === 0 ? (
            <div className="mt-2 rounded-xl border border-white/10 bg-slate-950/40 p-4 text-xs text-slate-400">
              No cell can be drawn for this session: none of its frames has a book usable level by level (crossed, out of order, or captured before 2026-09-07).
            </div>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
                <GradientKey side="bid" label="bid, resting" />
                <GradientKey side="ask" label="ask, resting" />
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-4 rounded-sm border border-white/10" style={{ background: cellFill("empty", 0) }} aria-hidden="true" />
                  seen, nothing resting
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-slate-500" aria-hidden="true" />
                  not seen (price outside the stored levels)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 bg-slate-200" aria-hidden="true" />
                  mid price
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{scaleSentence(available.scale)}</p>

              <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${MARGIN.top + bodies.plotH + MARGIN.bottom}`}
                className="mt-2 w-full cursor-crosshair rounded-lg bg-slate-950/60"
                role="img"
                aria-label="Heatmap of resting order-book quantity by price and time. Use the playback slider below to step through the day."
                onMouseMove={(event) => {
                  const { bucketIndex, row } = pointer(event);
                  setHover({
                    query,
                    text: bucketIndex === null || row === null
                      ? (bucketIndex === null ? "No column captured at this time (a hole in the capture, or outside the session)." : null)
                      : `${formatIstClock(Date.parse(available.buckets[bucketIndex]!.t))} IST · ${describeCell(available, lookup, bucketIndex, row)}`,
                  });
                }}
                onMouseLeave={() => setHover(null)}
                onClick={(event) => {
                  const { bucketIndex } = pointer(event);
                  if (bucketIndex !== null) { setPlaying(false); setCursor(() => bucketIndex); }
                }}
              >
                {geometry.gapSpans.map((gap) => (
                  <rect
                    key={`gap-${gap.x}`}
                    x={MARGIN.left + gap.x * PLOT_W}
                    y={MARGIN.top}
                    width={gap.width * PLOT_W}
                    height={bodies.plotH}
                    fill="rgba(251,191,36,0.08)"
                    stroke="rgba(251,191,36,0.35)"
                    strokeDasharray="3 3"
                  />
                ))}
                {bodies.cellRects}
                {midSegments(geometry).map((segment, index) => (
                  <polyline
                    key={`mid-${index}`}
                    points={segment.map((p) => `${(MARGIN.left + p.x * PLOT_W).toFixed(1)},${(MARGIN.top + p.y * bodies.plotH).toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke="rgba(226,232,240,0.9)"
                    strokeWidth={1.2}
                  />
                ))}
                {priceTicks.map((tick) => (
                  <g key={`p-${tick.y}`}>
                    <line x1={MARGIN.left - 4} x2={MARGIN.left} y1={tick.y} y2={tick.y} stroke="rgba(148,163,184,0.6)" />
                    <text x={MARGIN.left - 7} y={tick.y + 3} textAnchor="end" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
                  </g>
                ))}
                {hourTicks.map((at) => {
                  const x = MARGIN.left + ((at - Date.parse(available.window.from)) / span) * PLOT_W;
                  return (
                    <g key={`h-${at}`}>
                      <line x1={x} x2={x} y1={MARGIN.top + bodies.plotH} y2={MARGIN.top + bodies.plotH + 4} stroke="rgba(148,163,184,0.6)" />
                      <text x={x} y={MARGIN.top + bodies.plotH + 16} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.9)">{formatIstTime(at)}</text>
                    </g>
                  );
                })}
                {cursorBucket && (
                  <rect
                    x={MARGIN.left + ((Date.parse(cursorBucket.t) - Date.parse(available.window.from)) / span) * PLOT_W - 0.5}
                    y={MARGIN.top}
                    width={Math.max(geometry.columnWidth * PLOT_W, 1.5) + 1}
                    height={bodies.plotH}
                    fill="none"
                    stroke="rgba(255,255,255,0.95)"
                    strokeWidth={1}
                  />
                )}
              </svg>
              <p className="mt-1 min-h-[1.25rem] text-[11px] text-slate-300" aria-live="off">
                {hoverText ?? "Hover for the quantity at a price and time; click a column to show the book as it stood then."}
              </p>

              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-slate-200">Playback</span>
                  <button
                    type="button"
                    onClick={() => { setPlaying(false); setCursor((c) => Math.max(0, (c ?? 1) - 1)); }}
                    disabled={lastColumn < 0}
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 font-bold text-slate-200 disabled:opacity-40"
                    aria-label="Step back one column"
                  >◀</button>
                  <button
                    type="button"
                    onClick={() => {
                      if (playing) { setPlaying(false); return; }
                      if (cursor === null || cursor >= lastColumn) setCursor(() => 0);
                      setPlaying(true);
                    }}
                    disabled={lastColumn < 0}
                    className="rounded-lg border border-white/10 bg-violet-500/20 px-3 py-1 font-bold text-violet-200 disabled:opacity-40"
                  >{playing ? "Pause" : "Play"}</button>
                  <button
                    type="button"
                    onClick={() => { setPlaying(false); setCursor((c) => Math.min(lastColumn, (c ?? -1) + 1)); }}
                    disabled={lastColumn < 0}
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 font-bold text-slate-200 disabled:opacity-40"
                    aria-label="Step forward one column"
                  >▶</button>
                  <select
                    value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                    aria-label="Playback speed"
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
                  >
                    {SPEEDS.map((choice) => <option key={choice.columnsPerSecond} value={choice.columnsPerSecond}>{choice.label}</option>)}
                  </select>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, lastColumn)}
                    value={cursor ?? 0}
                    onChange={(event) => { setPlaying(false); setCursor(() => Number(event.target.value)); }}
                    aria-label="Playback position"
                    className="min-w-[10rem] flex-1"
                  />
                  <span className="font-mono text-slate-300">
                    {cursorBucket ? `${formatIstClock(Date.parse(cursorBucket.t))} IST` : "—"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Playback shows the book as it stood when the highlighted column closed, read back from the stored frames. Columns on either side of a hole are not consecutive in time.
                </p>
              </div>

              {asOf !== null ? (
                <div className="mt-3">
                  <DepthLadderPanel underlying={underlying} nowMs={nowMs} asOf={asOf} />
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-slate-500">Choose a column, or press Play, to see the full ladder at that moment.</p>
              )}
            </>
          )}

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and provenance</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(available.definitions).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{available.source}. Frames are stamped with our receive time, not the exchange&apos;s.</p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: a bright cell is displayed liquidity, not a level price must respect. Orders are placed and pulled, a large one can disappear before it trades, and resting quantity is not traded quantity.
          </p>
        </>
      )}
    </div>
  );
}
