"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import { dataAgeSeconds } from "../depth-history-view";
import {
  buildDevelopingChart,
  checkpointNearFraction,
  describePoint,
  developingNotes,
  developingQuery,
  developingRows,
  RESOLUTION_ROWS,
  type DevelopingAvailable,
  type DevelopingPayload,
} from "../developing-value-view";

/** A session in progress is refetched this often. A finished one never is. */
const REFRESH_MS = 60_000;

/** SVG user-space layout: the picture scales to the width of its container. */
const W = 1000;
const MARGIN = { left: 64, right: 12, top: 10, bottom: 24 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const PLOT_H = 300;
const SVG_H = MARGIN.top + PLOT_H + MARGIN.bottom;

const POC_COLOR = "#fbbf24";
const VA_FILL = "rgba(167,139,250,0.22)";
const VA_EDGE = "rgba(167,139,250,0.8)";
const VWAP_COLOR = "#38bdf8";

interface Loaded {
  key: string;
  payload: DevelopingPayload | null;
  fetchedAtMs: number | null;
  error: string | null;
}

function number(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * How the POC and value area of one futures session developed through the day: the volume profile rebuilt at each checkpoint.
 *
 * The same ESTIMATE as the volume profile above it (each bar's volume spread over its range). Early checkpoints are hollow
 * because they rest on few minutes; a POC move smaller than two rows is called within the resolution; a checkpoint with no
 * new bar is blank and cuts the line. Futures prices, front month of the day.
 */
export function DevelopingValuePanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [rowPoints, setRowPoints] = useState<number | null>(null);
  const [stepMinutes, setStepMinutes] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sessions, setSessions] = useState<NonNullable<DevelopingPayload["availableSessions"]>>([]);
  const [hover, setHover] = useState<{ query: string; text: string | null } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = developingQuery({ underlying, sessionDate, rowPoints, stepMinutes });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/volume-profile/developing?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Developing value request failed (${response.status}).`);
        }
        const body = await response.json() as { data: DevelopingPayload };
        if (body.data.availableSessions) setSessions(body.data.availableSessions);
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "Developing value could not be loaded.");
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
  const available: DevelopingAvailable | null = payload !== null && payload.available ? payload : null;
  const refreshing = available?.inProgress === true;

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  const geometry = useMemo(() => (available ? buildDevelopingChart(available) : null), [available]);
  const notes = useMemo(() => (available ? developingNotes(available) : []), [available]);
  const rows = useMemo(() => (available ? developingRows(available) : []), [available]);
  const hoverText = hover?.query === query ? hover.text : null;

  if (!supported) return null;

  const loading = loaded === null || loaded.key !== query;
  const failure = loaded?.key === query ? loaded.error : null;
  const ageSeconds = loaded?.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;

  const xOf = (fraction: number) => MARGIN.left + fraction * PLOT_W;
  const yOf = (fraction: number) => MARGIN.top + fraction * PLOT_H;
  const hourTicks = [10, 11, 12, 13, 14, 15].map((hour) => ({ x: xOf((hour * 60 - (9 * 60 + 15)) / 375), label: `${hour}:00` }));
  const priceTicks: Array<{ y: number; label: string }> = [];
  if (geometry && geometry.priceHigh > geometry.priceLow) {
    for (let i = 0; i <= 5; i += 1) {
      priceTicks.push({ y: yOf(i / 5), label: number(geometry.priceHigh - (i * (geometry.priceHigh - geometry.priceLow)) / 5) });
    }
  }
  const path = (run: Array<{ x: number; y: number }>) => run.map((p) => `${xOf(p.x).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(" ");

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-busy={loading} aria-label="Developing value">
      <h3 className="text-sm font-bold text-white">Developing value</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        The session&apos;s POC and value area as they formed: the volume profile rebuilt from the bars up to each checkpoint.
      </p>
      <div className="my-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Session
          <select value={sessionDate} onChange={(event) => setSessionDate(event.target.value)} className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200">
            <option value="">Latest</option>
            {sessions.map((session) => <option key={session.sessionDate} value={session.sessionDate}>{session.sessionDate}{session.complete ? "" : " · partial"}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Checkpoint every
          <select
            value={stepMinutes ?? available?.stepMinutes ?? ""}
            onChange={(event) => setStepMinutes(Number(event.target.value))}
            disabled={!available}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            {(available?.stepChoices ?? []).map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Rows
          <select
            value={rowPoints ?? available?.rowPoints ?? ""}
            onChange={(event) => setRowPoints(Number(event.target.value))}
            disabled={!available}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            {(available?.rowPointsChoices ?? []).map((points) => <option key={points} value={points}>{points} pts</option>)}
          </select>
        </label>
        <span className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-100">ESTIMATED from 1-minute bars</span>
      </div>

      {loading && <p className="mb-2 text-xs text-slate-400">Loading…</p>}
      {failure && (
        <p className="mb-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {failure}{available && ageSeconds !== null ? `${/[.!?]$/.test(failure) ? "" : "."} Showing the data fetched ${ageSeconds} s ago.` : ""}
        </p>
      )}
      {payload && !payload.available && (
        <p className="mb-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">{payload.reason}</p>
      )}

      {available && geometry && (
        <>
          <p className="mb-1 text-[11px] text-slate-400">
            {available.underlying} futures {available.contract.symbol} (expiry {available.contract.expiryDate}) · session {available.sessionDate} IST · checkpoints every {available.stepMinutes} minutes · rows of {available.rowPoints} pts
            {available.inProgress && ageSeconds !== null ? ` · session in progress, fetched ${ageSeconds} s ago, refreshed every minute` : ""}
          </p>
          {notes.map((note) => (
            <p key={note.text} className={`mb-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
          ))}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ background: POC_COLOR }} aria-hidden="true" />POC at each checkpoint</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-5 rounded-sm" style={{ background: VA_FILL, border: `1px solid ${VA_EDGE}` }} aria-hidden="true" />value area</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-5 border-t border-dotted" style={{ borderColor: VWAP_COLOR }} aria-hidden="true" />VWAP so far</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: POC_COLOR }} aria-hidden="true" />thin checkpoint (few bars)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-slate-200" aria-hidden="true" />1-minute close</span>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${SVG_H}`}
            className="mt-2 w-full cursor-crosshair rounded-lg bg-slate-950/60"
            role="img"
            aria-label="Developing value: the day's closes with the estimated POC, value area and VWAP at each checkpoint."
            onMouseMove={(event) => {
              const rect = svgRef.current?.getBoundingClientRect();
              if (!rect) return;
              const px = ((event.clientX - rect.left) / rect.width) * W;
              const near = checkpointNearFraction(geometry.checkpoints, (px - MARGIN.left) / PLOT_W);
              setHover({ query, text: near ? describePoint(available.points, near.index, available.rowPoints) : null });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <rect x={MARGIN.left} y={MARGIN.top} width={PLOT_W} height={PLOT_H} fill="none" stroke="rgba(255,255,255,0.08)" />
            {priceTicks.map((tick) => (
              <g key={`p-${tick.y}`}>
                <line x1={MARGIN.left} x2={W - MARGIN.right} y1={tick.y} y2={tick.y} stroke="rgba(255,255,255,0.05)" />
                <text x={MARGIN.left - 6} y={tick.y + 3} textAnchor="end" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
              </g>
            ))}

            {geometry.runs.map((run, index) => run.length < 2 ? null : (
              <polygon
                key={`va-${index}`}
                points={`${path(run.map((c) => ({ x: c.x, y: c.vah })))} ${path([...run].reverse().map((c) => ({ x: c.x, y: c.val })))}`}
                fill={VA_FILL}
                stroke={VA_EDGE}
                strokeWidth={0.8}
              />
            ))}
            {/* A single checkpoint between blanks has no neighbour to join: its value area is a short vertical bar. */}
            {geometry.runs.map((run) => run.length === 1 ? (
              <line key={`va1-${run[0]!.index}`} x1={xOf(run[0]!.x)} x2={xOf(run[0]!.x)} y1={yOf(run[0]!.vah)} y2={yOf(run[0]!.val)} stroke={VA_EDGE} strokeWidth={3} />
            ) : null)}

            <polyline points={path(geometry.closeLine)} fill="none" stroke="rgba(226,232,240,0.85)" strokeWidth={1.1} />

            {geometry.runs.map((run, index) => {
              const vwap = run.filter((c) => c.vwap !== null).map((c) => ({ x: c.x, y: c.vwap! }));
              return vwap.length < 2 ? null : <polyline key={`vw-${index}`} points={path(vwap)} fill="none" stroke={VWAP_COLOR} strokeWidth={1.3} strokeDasharray="1 3" />;
            })}
            {/* The POC moves in whole rows, so it is drawn as steps (level, then a jump at the next checkpoint), not a slope. */}
            {geometry.runs.map((run, index) => run.length < 2 ? null : (
              <polyline
                key={`poc-${index}`}
                points={path(run.flatMap((c, i) => (i === 0 ? [{ x: c.x, y: c.poc }] : [{ x: c.x, y: run[i - 1]!.poc }, { x: c.x, y: c.poc }])))}
                fill="none"
                stroke={POC_COLOR}
                strokeWidth={1.8}
              />
            ))}
            {geometry.checkpoints.map((c) => (
              <circle
                key={`pt-${c.index}`}
                cx={xOf(c.x)}
                cy={yOf(c.poc)}
                r={3.5}
                fill={c.thin ? "rgba(2,6,23,0.9)" : POC_COLOR}
                stroke={POC_COLOR}
                strokeWidth={1.5}
              />
            ))}

            {hourTicks.map((tick) => (
              <g key={tick.label}>
                <line x1={tick.x} x2={tick.x} y1={MARGIN.top + PLOT_H} y2={MARGIN.top + PLOT_H + 4} stroke="rgba(148,163,184,0.6)" />
                <text x={tick.x} y={MARGIN.top + PLOT_H + 16} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
              </g>
            ))}
          </svg>
          <p className="mt-1 min-h-[1.25rem] text-[11px] text-slate-300" aria-live="off">
            {hoverText ?? "Hover near a checkpoint for its levels, the POC move since the last one against the resolution, and the bars it rests on."}
          </p>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[11px] text-slate-300">
              <caption className="mb-1 text-left text-slate-400">
                The levels at each checkpoint (estimated). A POC move of {RESOLUTION_ROWS * available.rowPoints} pts or less is within the resolution of {available.rowPoints}-point rows.
              </caption>
              <thead className="text-slate-500">
                <tr>
                  <th className="pr-3 font-normal">Checkpoint</th>
                  <th className="pr-3 font-normal">POC</th>
                  <th className="pr-3 font-normal">Move</th>
                  <th className="pr-3 font-normal">Value area</th>
                  <th className="pr-3 font-normal">VWAP</th>
                  <th className="pr-3 font-normal">Close</th>
                  <th className="font-normal">Bars</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.at} className="border-t border-white/5">
                    <td className="pr-3">{row.at}{row.thin && !row.blank ? " · thin" : ""}</td>
                    {row.blank ? (
                      <td colSpan={5} className="pr-3 text-slate-500">no new bar since the previous checkpoint</td>
                    ) : (
                      <>
                        <td className="pr-3">{row.poc === null ? "–" : number(row.poc)}</td>
                        <td className="pr-3">
                          {row.shift === null ? "–" : `${row.shift > 0 ? "+" : row.shift < 0 ? "−" : ""}${number(Math.abs(row.shift))}${row.withinResolution ? " (within resolution)" : ""}`}
                        </td>
                        <td className="pr-3">{row.valueArea ?? "–"}</td>
                        <td className="pr-3">{row.vwap === null ? "–" : number(row.vwap)}</td>
                        <td className="pr-3">{row.close === null ? "–" : number(row.close)}</td>
                      </>
                    )}
                    <td>{row.barsUsed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and provenance</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(available.definitions).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{available.source}. {available.volumeUnit}.</p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: where value developed describes the session so far; a POC or value-area edge is not support, resistance or a forecast.
          </p>
        </>
      )}
    </section>
  );
}
