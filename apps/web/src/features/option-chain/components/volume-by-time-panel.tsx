"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import { dataAgeSeconds } from "../depth-history-view";
import {
  bucketAtFraction,
  buildTimeChart,
  dayVolumeSentence,
  describeBucket,
  formatAxisUnits,
  volumeByTimeNotes,
  volumeByTimeQuery,
  type VolumeByTimeAvailable,
  type VolumeByTimePayload,
} from "../volume-by-time-view";

/** A session in progress is refetched this often. A finished one never is. */
const REFRESH_MS = 60_000;

/** SVG user-space layout: the picture scales to the width of its container. */
const W = 1000;
const MARGIN = { left: 64, right: 12 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const VOLUME_TOP = 10;
const VOLUME_H = 190;
const CUM_TOP = VOLUME_TOP + VOLUME_H + 26;
const CUM_H = 130;
const SVG_H = CUM_TOP + CUM_H + 24;

const BAR_COLOR = "rgba(167,139,250,0.75)";
const BASELINE_COLOR = "#e2e8f0";
const TODAY_COLOR = "#a78bfa";
const CUM_BASELINE_COLOR = "rgba(148,163,184,0.9)";

interface Loaded {
  key: string;
  payload: VolumeByTimePayload | null;
  fetchedAtMs: number | null;
  error: string | null;
}

/**
 * How one futures session's traded volume was spread over the day, against the same time of day in previous sessions.
 *
 * Observed volume (the reported 1-minute bar volume summed by clock bucket), not an estimate. Unknown minutes are blank, not
 * zero; a bucket missing minutes is outlined and has no ratio; the baseline is the median over previous sessions of the same
 * contract and the screen says how many sessions each figure stands on. Futures only, front month of the day.
 */
export function VolumeByTimePanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [bucketMinutes, setBucketMinutes] = useState<number | null>(null);
  const [baselineDays, setBaselineDays] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sessions, setSessions] = useState<NonNullable<VolumeByTimePayload["availableSessions"]>>([]);
  const [hover, setHover] = useState<{ query: string; text: string | null } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = volumeByTimeQuery({ underlying, sessionDate, bucketMinutes, baselineDays });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/volume-by-time?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Volume by time request failed (${response.status}).`);
        }
        const body = await response.json() as { data: VolumeByTimePayload };
        if (body.data.availableSessions) setSessions(body.data.availableSessions);
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "Volume by time could not be loaded.");
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
  const available: VolumeByTimeAvailable | null = payload !== null && payload.available ? payload : null;
  const refreshing = available?.inProgress === true;

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  const geometry = useMemo(() => (available ? buildTimeChart(available) : null), [available]);
  const notes = useMemo(() => (available ? volumeByTimeNotes(available) : []), [available]);
  const daySentence = useMemo(() => (available ? dayVolumeSentence(available) : null), [available]);
  const hoverText = hover?.query === query ? hover.text : null;

  if (!supported) return null;

  const loading = loaded === null || loaded.key !== query;
  const failure = loaded?.key === query ? loaded.error : null;
  const ageSeconds = loaded?.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;

  const xOf = (fraction: number) => MARGIN.left + fraction * PLOT_W;
  const yVolume = (fraction: number) => VOLUME_TOP + (1 - fraction) * VOLUME_H;
  const yCum = (fraction: number) => CUM_TOP + (1 - fraction) * CUM_H;
  const hourTicks = [10, 11, 12, 13, 14, 15].map((hour) => ({ x: xOf((hour * 60 - (9 * 60 + 15)) / 375), label: `${hour}:00` }));

  const pointerBucket = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !geometry || !available) return null;
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const bucket = bucketAtFraction(geometry.buckets, (px - MARGIN.left) / PLOT_W);
    return bucket ? available.buckets[bucket.index] ?? null : null;
  };

  const line = (run: Array<{ x: number; y: number }>) => run.map((p) => `${xOf(p.x).toFixed(1)},${yCum(p.y).toFixed(1)}`).join(" ");

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-busy={loading} aria-label="Volume by time of day">
      <h3 className="text-sm font-bold text-white">Volume by time of day</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        The traded volume of the session by time bucket, against the median of the same bucket in previous sessions of the same contract.
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
          Bucket
          <select
            value={bucketMinutes ?? available?.bucketMinutes ?? ""}
            onChange={(event) => setBucketMinutes(Number(event.target.value))}
            disabled={!available}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            {(available?.bucketMinuteChoices ?? []).map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Compared with
          <select
            value={baselineDays ?? available?.baseline.requestedSessions ?? ""}
            onChange={(event) => setBaselineDays(Number(event.target.value))}
            disabled={!available}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            {(available?.baselineDayChoices ?? []).map((days) => <option key={days} value={days}>previous {days} sessions</option>)}
          </select>
        </label>
        <span className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-100" title={available?.definitions.observed}>
          OBSERVED volume
        </span>
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
            {available.underlying} futures {available.contract.symbol} (expiry {available.contract.expiryDate}) · session {available.sessionDate} IST · {available.bucketMinutes}-minute buckets
            {available.inProgress && ageSeconds !== null ? ` · session in progress, fetched ${ageSeconds} s ago, refreshed every minute` : ""}
          </p>
          {daySentence && <p className="mb-1 text-[11px] text-slate-200">{daySentence}</p>}
          {notes.map((note) => (
            <p key={note.text} className={`mb-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
          ))}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: BAR_COLOR }} aria-hidden="true" />volume in the bucket</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: BASELINE_COLOR }} aria-hidden="true" />median of previous sessions</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-amber-300" aria-hidden="true" />missing minutes (lower bound)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-slate-500/20" aria-hidden="true" />no stored bar (unknown, not zero)</span>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${SVG_H}`}
            className="mt-2 w-full cursor-crosshair rounded-lg bg-slate-950/60"
            role="img"
            aria-label="Volume by time of day: bars for each time bucket with the median of previous sessions marked, and below it the cumulative volume against the median cumulative volume."
            onMouseMove={(event) => {
              const bucket = pointerBucket(event);
              setHover({ query, text: bucket ? describeBucket(bucket) : null });
            }}
            onMouseLeave={() => setHover(null)}
          >
            {/* Volume axis */}
            {geometry.volumeAxis.ticks.map((tick) => {
              const y = yVolume(tick / geometry.volumeAxis.top);
              return (
                <g key={`v-${tick}`}>
                  <line x1={MARGIN.left} x2={W - MARGIN.right} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" />
                  <text x={MARGIN.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill="rgba(148,163,184,0.9)">{formatAxisUnits(tick)}</text>
                </g>
              );
            })}
            <rect x={MARGIN.left} y={VOLUME_TOP} width={PLOT_W} height={VOLUME_H} fill="none" stroke="rgba(255,255,255,0.08)" />

            {geometry.buckets.map((bucket) => {
              const x = xOf(bucket.x0) + 0.5;
              const width = Math.max(1, (bucket.x1 - bucket.x0) * PLOT_W - 1);
              if (!bucket.known) {
                return <rect key={`u-${bucket.index}`} x={x} y={VOLUME_TOP} width={width} height={VOLUME_H} fill="rgba(148,163,184,0.1)" />;
              }
              const top = yVolume(bucket.height);
              return bucket.complete ? (
                <rect key={`b-${bucket.index}`} x={x} y={top} width={width} height={Math.max(0.5, VOLUME_TOP + VOLUME_H - top)} fill={BAR_COLOR} />
              ) : (
                <rect key={`b-${bucket.index}`} x={x} y={top} width={width} height={Math.max(0.5, VOLUME_TOP + VOLUME_H - top)} fill="rgba(252,211,77,0.15)" stroke="#fcd34d" strokeDasharray="3 2" />
              );
            })}
            {geometry.buckets.map((bucket) => bucket.baselineHeight === null ? null : (
              <line key={`m-${bucket.index}`} x1={xOf(bucket.x0)} x2={xOf(bucket.x1)} y1={yVolume(bucket.baselineHeight)} y2={yVolume(bucket.baselineHeight)} stroke={BASELINE_COLOR} strokeWidth={1.6} />
            ))}

            {/* Cumulative panel */}
            {geometry.cumulativeAxis.ticks.map((tick) => {
              const y = yCum(tick / geometry.cumulativeAxis.top);
              return (
                <g key={`c-${tick}`}>
                  <line x1={MARGIN.left} x2={W - MARGIN.right} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" />
                  <text x={MARGIN.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill="rgba(148,163,184,0.9)">{formatAxisUnits(tick)}</text>
                </g>
              );
            })}
            <rect x={MARGIN.left} y={CUM_TOP} width={PLOT_W} height={CUM_H} fill="none" stroke="rgba(255,255,255,0.08)" />
            {geometry.cumulativeBaseline.map((run, index) => (
              <polyline key={`cb-${index}`} points={line(run)} fill="none" stroke={CUM_BASELINE_COLOR} strokeWidth={1.4} strokeDasharray="4 3" />
            ))}
            {geometry.cumulativeToday.map((run, index) => (
              <polyline key={`ct-${index}`} points={line(run)} fill="none" stroke={TODAY_COLOR} strokeWidth={1.8} />
            ))}
            <text x={MARGIN.left + 4} y={CUM_TOP + 12} fontSize={10} fill="rgba(148,163,184,0.9)">cumulative since the open (dashed: median of previous sessions)</text>

            {hourTicks.map((tick) => (
              <g key={tick.label}>
                <line x1={tick.x} x2={tick.x} y1={CUM_TOP + CUM_H} y2={CUM_TOP + CUM_H + 4} stroke="rgba(148,163,184,0.6)" />
                <text x={tick.x} y={CUM_TOP + CUM_H + 16} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
              </g>
            ))}
          </svg>
          <p className="mt-1 min-h-[1.25rem] text-[11px] text-slate-300" aria-live="off">
            {hoverText ?? "Hover over a bucket for its volume, the ratio to the usual, and how many sessions the usual stands on."}
          </p>

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and provenance</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(available.definitions).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{available.source}. {available.volumeUnit}. Baseline sessions: {available.baseline.dates.join(", ") || "none"}.</p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: heavier or lighter than usual describes the past; it says nothing about what price does next.
          </p>
        </>
      )}
    </section>
  );
}
