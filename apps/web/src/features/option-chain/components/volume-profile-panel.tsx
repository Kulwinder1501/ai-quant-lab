"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import { dataAgeSeconds } from "../depth-history-view";
import { formatIstTime } from "../oi-format";
import {
  buildProfileGeometry,
  COMPOSITE_DAY_CHOICES,
  describeRange,
  describeResolution,
  describeRow,
  edgeAllowed,
  previousSessionSentence,
  priceFraction,
  profileScope,
  profileSessionLabel,
  qualityNotes,
  RANGE_EDGES,
  RANGE_PRESETS,
  rowAtFraction,
  volumeProfileQuery,
  type ProfileSessionListing,
  type VolumeProfileAvailable,
  type VolumeProfilePayload,
} from "../volume-profile-view";

/** A session in progress is refetched this often (new bars arrive every few minutes). A finished one never is. */
const REFRESH_MS = 60_000;

/** SVG user-space layout: the picture scales to the width of its container. */
const W = 1000;
const MARGIN = { left: 64, right: 12, top: 10, bottom: 24 };
const PRICE_PANEL_W = 560;
const PANEL_GAP = 12;
const HIST_PANEL_W = W - MARGIN.left - MARGIN.right - PRICE_PANEL_W - PANEL_GAP;
const HIST_LEFT = MARGIN.left + PRICE_PANEL_W + PANEL_GAP;

const POC_COLOR = "#fbbf24";
const VA_COLOR = "#a78bfa";
const VWAP_COLOR = "#38bdf8";
const PREVIOUS_COLOR = "rgba(148,163,184,0.85)";

interface Loaded {
  key: string;
  payload: VolumeProfilePayload | null;
  fetchedAtMs: number | null;
  error: string | null;
}

function number(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * An ESTIMATED volume-by-price profile of one regular futures session, from stored 1-minute bars.
 *
 * Each bar's volume is spread evenly over its high-low range, so where inside a minute the volume traded is assumed,
 * not observed, and the screen says so beside the picture. The same session rebuilt from 5-minute bars is summarised
 * under it, so the reader can see how far the POC and the value-area edges move with the bar size. Futures prices, the
 * same ones the depth views show; the front month of the day, never another contract.
 */
export function VolumeProfilePanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [sessionDate, setSessionDate] = useState("");
  const [rowPoints, setRowPoints] = useState<number | null>(null);
  /** The window of the session, `HH:MM` IST; empty is the session's own edge. */
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  /** How many sessions are added up, ending at the chosen one. */
  const [days, setDays] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sessions, setSessions] = useState<ProfileSessionListing[]>([]);
  const [hover, setHover] = useState<{ query: string; text: string | null } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = volumeProfileQuery({ underlying, sessionDate, rowPoints, from: rangeFrom, to: rangeTo, days });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/volume-profile?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Volume profile request failed (${response.status}).`);
        }
        const body = await response.json() as { data: VolumeProfilePayload };
        if (body.data.availableSessions) setSessions(body.data.availableSessions);
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "The volume profile could not be loaded.");
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
  const available: VolumeProfileAvailable | null = payload !== null && payload.available ? payload : null;
  const refreshing = available?.inProgress === true;

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  const geometry = useMemo(() => (available ? buildProfileGeometry(available) : null), [available]);
  const notes = useMemo(() => (available ? qualityNotes(available) : []), [available]);
  const resolution = useMemo(
    () => (available ? describeResolution(available.sensitivity, available.profile.rowPoints) : null),
    [available],
  );
  const hoverText = hover?.query === query ? hover.text : null;

  if (!supported) {
    return (
      <p className="rounded-xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-300">
        A volume profile is built from the index futures ({DEPTH_UNDERLYINGS.join(" and ")}) only. {underlying} has no futures volume here.
      </p>
    );
  }

  const loading = loaded === null || loaded.key !== query;
  const failure = loaded?.key === query ? loaded.error : null;
  const ageSeconds = loaded?.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;
  const plotH = geometry ? Math.min(700, Math.max(320, geometry.rows.length * 7)) : 0;
  const svgHeight = MARGIN.top + plotH + MARGIN.bottom;
  const yOf = (fraction: number): number => MARGIN.top + fraction * plotH;

  const pointerRow = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !geometry) return null;
    const py = ((event.clientY - rect.top) / rect.height) * svgHeight;
    return rowAtFraction(geometry.rows, (py - MARGIN.top) / plotH);
  };
  const setWindow = (from: string, to: string) => { setRangeFrom(from); setRangeTo(to); };
  const presetActive = (preset: { from: string; to: string }) => preset.from === rangeFrom && preset.to === rangeTo;

  /** A horizontal level across both panels, with its label on the left axis side. */
  const levels = available && geometry
    ? [
      { key: "poc", label: "POC", price: available.profile.poc, color: POC_COLOR, dash: undefined, width: 1.6 },
      { key: "vah", label: "VAH", price: available.profile.vah, color: VA_COLOR, dash: "5 3", width: 1.2 },
      { key: "val", label: "VAL", price: available.profile.val, color: VA_COLOR, dash: "5 3", width: 1.2 },
      ...(available.profile.vwap !== null ? [{ key: "vwap", label: "VWAP", price: available.profile.vwap, color: VWAP_COLOR, dash: "1 3", width: 1.4 }] : []),
      ...(available.previousSession
        ? [
          { key: "ppoc", label: "prev POC", price: available.previousSession.poc, color: PREVIOUS_COLOR, dash: "2 4", width: 1 },
          { key: "pvah", label: "prev VAH", price: available.previousSession.vah, color: PREVIOUS_COLOR, dash: "2 4", width: 1 },
          { key: "pval", label: "prev VAL", price: available.previousSession.val, color: PREVIOUS_COLOR, dash: "2 4", width: 1 },
        ]
        : []),
    ].map((level) => ({ ...level, fraction: priceFraction(geometry, level.price) }))
    : [];
  const hiddenLevels = levels.filter((level) => level.fraction === null).map((level) => `${level.label} ${number(level.price)}`);

  const priceTicks: Array<{ y: number; label: string }> = [];
  if (geometry && geometry.rows.length > 0) {
    const step = Math.max(1, Math.round(geometry.rows.length / 6));
    for (let i = 0; i <= geometry.rows.length; i += step) {
      const price = geometry.priceHigh - (i * (geometry.priceHigh - geometry.priceLow)) / geometry.rows.length;
      priceTicks.push({ y: yOf(i / geometry.rows.length), label: number(price) });
    }
  }
  const hourTicks = [10, 11, 12, 13, 14, 15].map((hour) => ({
    x: MARGIN.left + ((hour * 60 - (9 * 60 + 15)) / 375) * PRICE_PANEL_W,
    label: `${hour}:00`,
  }));

  return (
    <div className="w-full" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          {days > 1 ? "Ending" : "Session"}
          <select
            value={sessionDate}
            onChange={(event) => setSessionDate(event.target.value)}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">Latest</option>
            {sessions.map((session) => <option key={session.sessionDate} value={session.sessionDate}>{profileSessionLabel(session)}</option>)}
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
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Sessions
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            {COMPOSITE_DAY_CHOICES.map((count) => <option key={count} value={count}>{count === 1 ? "1 (single)" : `${count} (composite)`}</option>)}
          </select>
        </label>
        <span className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-100" title={available?.definitions.estimate}>
          ESTIMATED from 1-minute bars
        </span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Window of the session">
        <span className="text-xs text-slate-400">Window</span>
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => setWindow(preset.from, preset.to)}
            aria-pressed={presetActive(preset)}
            className={`rounded-lg border px-2 py-0.5 text-[11px] ${presetActive(preset) ? "border-violet-400/60 bg-violet-500/20 text-violet-100" : "border-white/10 bg-slate-950/60 text-slate-300 hover:bg-white/5"}`}
          >
            {preset.label}
          </button>
        ))}
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          from
          <select
            value={rangeFrom}
            onChange={(event) => setRangeFrom(event.target.value)}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-200"
          >
            <option value="">09:15</option>
            {RANGE_EDGES.filter((edge) => edge !== "09:15").map((edge) => (
              <option key={edge} value={edge} disabled={!edgeAllowed("from", edge, rangeTo)}>{edge}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          to
          <select
            value={rangeTo}
            onChange={(event) => setRangeTo(event.target.value)}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-200"
          >
            {RANGE_EDGES.filter((edge) => edge !== "15:30").map((edge) => (
              <option key={edge} value={edge} disabled={!edgeAllowed("to", edge, rangeFrom)}>{edge}</option>
            ))}
            <option value="">15:30</option>
          </select>
        </label>
        <span className="text-[11px] text-slate-500">IST, start included, end excluded</span>
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
            {available.underlying} futures {available.contract.symbol} (expiry {available.contract.expiryDate}) ·{" "}
            {available.composite.usedDays > 1
              ? `${available.composite.usedDays} sessions ${available.composite.dates[0]} to ${available.sessionDate}`
              : `session ${available.sessionDate}`} IST ·{" "}
            {available.range.isFullSession ? "whole session" : `window ${describeRange(available.range)}`}
            {available.composite.usedDays > 1 && !available.range.isFullSession ? " of each" : ""} ·{" "}
            {number(available.profile.totalVolume)} units · rows of {available.profile.rowPoints} pts
            {available.range.summary ? ` · open ${number(available.range.summary.open)}, high ${number(available.range.summary.high)}, low ${number(available.range.summary.low)}, close ${number(available.range.summary.close)}` : ""}
            {available.inProgress && ageSeconds !== null ? ` · session in progress, fetched ${ageSeconds} s ago, refreshed every minute` : ""}
          </p>
          {notes.map((note) => (
            <p key={note.text} className={`mb-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
          ))}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ background: POC_COLOR }} aria-hidden="true" />POC {number(available.profile.poc)}</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0 w-5 border-t border-dashed" style={{ borderColor: VA_COLOR }} aria-hidden="true" />
              value area {number(available.profile.val)}–{number(available.profile.vah)} ({(available.profile.valueAreaShare * 100).toFixed(0)}% of volume)
            </span>
            {available.profile.vwap !== null && (
              <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-5 border-t border-dotted" style={{ borderColor: VWAP_COLOR }} aria-hidden="true" />VWAP {number(available.profile.vwap)}</span>
            )}
            {available.previousSession && (
              <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-5 border-t border-dotted" style={{ borderColor: PREVIOUS_COLOR }} aria-hidden="true" />previous session</span>
            )}
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-slate-200" aria-hidden="true" />1-minute close</span>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${svgHeight}`}
            className="mt-2 w-full cursor-crosshair rounded-lg bg-slate-950/60"
            role="img"
            aria-label="Estimated volume by price for the session: closes over the day on the left, estimated volume at each price row on the right."
            onMouseMove={(event) => {
              const row = pointerRow(event);
              setHover({ query, text: row ? describeRow(row, profileScope(available)) : null });
            }}
            onMouseLeave={() => setHover(null)}
          >
            {/* Value area band across both panels */}
            {(() => {
              const top = priceFraction(geometry, Math.min(available.profile.vah, geometry.priceHigh));
              const bottom = priceFraction(geometry, Math.max(available.profile.val, geometry.priceLow));
              if (top === null || bottom === null) return null;
              return (
                <rect
                  x={MARGIN.left}
                  y={yOf(top)}
                  width={PRICE_PANEL_W + PANEL_GAP + HIST_PANEL_W}
                  height={Math.max(0, yOf(bottom) - yOf(top))}
                  fill="rgba(167,139,250,0.08)"
                />
              );
            })()}
            {/* The parts of the clock outside the chosen window (of each session), dimmed: nothing there is in the profile. */}
            {!available.range.isFullSession && [
              { from: 0, to: geometry.windowBands[0]!.from },
              ...geometry.windowBands.slice(1).map((band, index) => ({ from: geometry.windowBands[index]!.to, to: band.from })),
              { from: geometry.windowBands[geometry.windowBands.length - 1]!.to, to: 1 },
            ].map((gap) => (
              <rect
                key={`dim-${gap.from}`}
                x={MARGIN.left + gap.from * PRICE_PANEL_W}
                y={MARGIN.top}
                width={Math.max(0, (gap.to - gap.from) * PRICE_PANEL_W)}
                height={plotH}
                fill="rgba(2,6,23,0.7)"
              />
            ))}
            {/* Session boundaries of a composite. */}
            {geometry.sessionStarts.length > 1 && geometry.sessionStarts.slice(1).map((start) => (
              <line key={`sep-${start.date}`} x1={MARGIN.left + start.x * PRICE_PANEL_W} x2={MARGIN.left + start.x * PRICE_PANEL_W} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="rgba(148,163,184,0.35)" strokeDasharray="2 3" />
            ))}
            <rect x={MARGIN.left} y={MARGIN.top} width={PRICE_PANEL_W} height={plotH} fill="none" stroke="rgba(255,255,255,0.08)" />
            <rect x={HIST_LEFT} y={MARGIN.top} width={HIST_PANEL_W} height={plotH} fill="none" stroke="rgba(255,255,255,0.08)" />

            {geometry.rows.map((row) => (
              <rect
                key={row.low}
                x={HIST_LEFT}
                y={yOf(row.y) + 0.4}
                width={Math.max(0, row.width * HIST_PANEL_W)}
                height={Math.max(0.8, row.height * plotH - 0.8)}
                fill={row.isPoc ? "rgba(251,191,36,0.85)" : row.inValueArea ? "rgba(167,139,250,0.6)" : "rgba(148,163,184,0.4)"}
              />
            ))}

            <polyline
              points={geometry.closeLine.map((p) => `${(MARGIN.left + p.x * PRICE_PANEL_W).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(" ")}
              fill="none"
              stroke="rgba(226,232,240,0.9)"
              strokeWidth={1.2}
            />

            {levels.map((level) => level.fraction === null ? null : (
              <g key={level.key}>
                <line x1={MARGIN.left} x2={W - MARGIN.right} y1={yOf(level.fraction)} y2={yOf(level.fraction)} stroke={level.color} strokeWidth={level.width} strokeDasharray={level.dash} />
                <text x={MARGIN.left + 4} y={yOf(level.fraction) - 3} fontSize={9} fill={level.color}>{level.label}</text>
              </g>
            ))}

            {priceTicks.map((tick) => (
              <g key={`p-${tick.y}`}>
                <line x1={MARGIN.left - 4} x2={MARGIN.left} y1={tick.y} y2={tick.y} stroke="rgba(148,163,184,0.6)" />
                <text x={MARGIN.left - 7} y={tick.y + 3} textAnchor="end" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
              </g>
            ))}
            {(geometry.sessionStarts.length > 1
              ? geometry.sessionStarts.map((start, index, all) => ({
                x: MARGIN.left + (start.x + 0.5 / all.length) * PRICE_PANEL_W,
                label: start.date.slice(5),
              }))
              : hourTicks).map((tick) => (
              <g key={`h-${tick.label}`}>
                <line x1={tick.x} x2={tick.x} y1={MARGIN.top + plotH} y2={MARGIN.top + plotH + 4} stroke="rgba(148,163,184,0.6)" />
                <text x={tick.x} y={MARGIN.top + plotH + 16} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.9)">{tick.label}</text>
              </g>
            ))}
            <text x={HIST_LEFT + HIST_PANEL_W / 2} y={MARGIN.top + plotH + 16} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.9)">
              estimated volume at price →
            </text>
          </svg>
          <p className="mt-1 min-h-[1.25rem] text-[11px] text-slate-300" aria-live="off">
            {hoverText ?? "Hover over the bars for the estimated volume in a row."}
          </p>
          {hiddenLevels.length > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">Not drawn, outside the price range of the profile above: {hiddenLevels.join(", ")}.</p>
          )}

          {resolution && (
            <p className={`mt-2 rounded-lg border px-3 py-2 text-[11px] ${resolution.tone === "warn" ? "border-amber-400/40 bg-amber-500/10 text-amber-100" : "border-white/10 bg-slate-950/40 text-slate-300"}`}>
              <span className="font-bold">Resolution check. </span>{resolution.text}
            </p>
          )}
          {available.composite.usedDays > 1 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-[11px] text-slate-300">
                <caption className="mb-1 text-left text-slate-400">Each session on its own, same rows and window (estimated).</caption>
                <thead className="text-slate-500">
                  <tr><th className="pr-3 font-normal">Session</th><th className="pr-3 font-normal">POC</th><th className="pr-3 font-normal">Value area</th><th className="pr-3 font-normal">Range</th><th className="pr-3 font-normal">Close</th><th className="font-normal">Units</th></tr>
                </thead>
                <tbody>
                  {[...available.composite.perSession].reverse().map((session) => (
                    <tr key={session.sessionDate} className="border-t border-white/5">
                      <td className="pr-3">{session.sessionDate}{session.complete ? "" : " · partial"}</td>
                      <td className="pr-3">{session.poc === null ? "–" : number(session.poc)}</td>
                      <td className="pr-3">{session.val === null || session.vah === null ? "–" : `${number(session.val)}–${number(session.vah)}`}</td>
                      <td className="pr-3">{session.low === null || session.high === null ? "–" : `${number(session.low)}–${number(session.high)}`}</td>
                      <td className="pr-3">{session.close === null ? "–" : number(session.close)}</td>
                      <td>{number(session.totalVolume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {previousSessionSentence(available.previousSession, !available.range.isFullSession) && (
            <p className="mt-2 text-[11px] text-slate-400">{previousSessionSentence(available.previousSession, !available.range.isFullSession)}</p>
          )}

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and provenance</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(available.definitions).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{available.source}. {available.volumeUnit}. Session {formatIstTime(Date.parse(available.session?.firstBarAt ?? ""))}–{formatIstTime(Date.parse(available.session?.lastBarAt ?? "") + 60_000)} IST.</p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            Observation, not a signal: the profile is an estimate of where volume traded, built on the assumption that each minute&apos;s volume was spread evenly across its range. A POC or value-area edge is not support, resistance or a target.
          </p>
        </>
      )}
    </div>
  );
}
