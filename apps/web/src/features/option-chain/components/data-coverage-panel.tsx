"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import {
  ageText,
  cellTone,
  collectorSentences,
  coverageNotes,
  dataCoverageQuery,
  depthFramesText,
  istSpan,
  snapshotCountText,
  STATUS_LABEL,
  type CoverageStatus,
  type DataCoverageAvailable,
} from "../data-coverage-view";

/** Refetched this often: the freshness lines are only useful if they are fresh. */
const REFRESH_MS = 60_000;

const TONE_CLASS = {
  good: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  warn: "border-amber-400/40 bg-amber-500/10 text-amber-100",
  bad: "border-rose-400/40 bg-rose-500/10 text-rose-200",
  neutral: "border-white/10 bg-white/5 text-slate-400",
} as const;

interface Loaded {
  key: string;
  data: DataCoverageAvailable | null;
  error: string | null;
}

function Chip({ status, probableHoliday, notCollected = false }: { status: CoverageStatus; probableHoliday: boolean; notCollected?: boolean }) {
  return (
    <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE_CLASS[cellTone(status, probableHoliday, notCollected)]}`}>
      {notCollected && status === "none" ? "not collected" : STATUS_LABEL[status]}
    </span>
  );
}

/**
 * What is stored from each source behind the terminal, for each recent weekday: 1-minute futures bars, option-chain snapshots and
 * depth frames. Counts and times only. A weekday with no futures bars and no whole collector day is shown as a probable
 * holiday (an inference, said so), not as three failures; a day the market traded with a source that has nothing is a gap.
 */
export function DataCoveragePanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [days, setDays] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = dataCoverageQuery({ underlying, days });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/data-coverage?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Data coverage request failed (${response.status}).`);
        }
        const body = await response.json() as { data: DataCoverageAvailable };
        setLoaded({ key: query, data: body.data, error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        const message = errorMessage(caught, "Data coverage could not be loaded.");
        setLoaded((previous) => (previous !== null && previous.key === query && previous.data !== null ? { ...previous, error: message } : { key: query, data: null, error: message }));
      }
    })();
    return () => controller.abort();
  }, [query, refreshTick, supported]);

  useEffect(() => {
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const data = loaded?.key === query ? loaded.data : null;
  const notes = useMemo(() => (data ? coverageNotes(data) : []), [data]);

  if (!supported) {
    return (
      <p className="rounded-xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-300">
        Data coverage is tracked for the index futures ({DEPTH_UNDERLYINGS.join(" and ")}) only.
      </p>
    );
  }

  const loading = loaded === null || loaded.key !== query;
  const failure = loaded?.key === query ? loaded.error : null;

  return (
    <div className="w-full" aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Look back
          <select
            value={days ?? data?.days ?? ""}
            onChange={(event) => setDays(Number(event.target.value))}
            disabled={!data}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            {(data?.dayChoices ?? []).map((count) => <option key={count} value={count}>{count} weekdays</option>)}
          </select>
        </label>
        <span className="rounded-lg border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-bold text-sky-100">COUNTS AND TIMES ONLY</span>
      </div>

      {loading && <p className="mb-2 text-xs text-slate-400">Loading…</p>}
      {failure && <p className="mb-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{failure}</p>}

      {data && (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-3" aria-label="Freshness">
            {([
              ["Futures bars", data.latest.futuresBarAt],
              ["Chain snapshot", data.latest.snapshotAt],
              ["Depth frame", data.latest.depthFrameAt],
            ] as const).map(([label, at]) => (
              <div key={label} className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Last written · {label}</p>
                <p className="text-sm font-bold text-white">{ageText(at, nowMs)}</p>
                <p className="text-[11px] text-slate-500">{at ? new Date(at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false, dateStyle: "short", timeStyle: "short" }) + " IST" : "nothing stored"}</p>
              </div>
            ))}
          </div>
          <p className="mb-2 text-[11px] text-slate-500">Freshness is when each source last wrote, at any hour. The depth collector runs outside market hours; futures bars are only stored for 09:15–15:30.</p>

          {notes.map((note) => (
            <p key={note.text} className={`mb-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-400"}`}>{note.text}</p>
          ))}

          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[11px] text-slate-300">
              <thead className="text-slate-500">
                <tr>
                  <th className="pr-3 font-normal">Session</th>
                  <th className="pr-3 font-normal">Futures bars (of 375)</th>
                  <th className="pr-3 font-normal">Chain snapshots</th>
                  <th className="pr-3 font-normal">Depth frames</th>
                  <th className="font-normal">Note and why</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.date} className={`border-t border-white/5 ${row.probableHoliday ? "text-slate-500" : ""}`}>
                    <td className="py-1 pr-3 align-top">{row.date}{row.inProgress ? <span className="ml-1 text-[10px] text-sky-300">in progress</span> : null}</td>
                    <td className="pr-3 align-top">
                      <Chip status={row.futures.status} probableHoliday={row.probableHoliday} notCollected={data.sourcesNotCollected.includes("futures")} />
                      <span className="ml-2">{row.futures.bars}</span>
                      <span className="block text-[10px] text-slate-500">{istSpan(row.futures.firstAt, row.futures.lastAt)} IST</span>
                    </td>
                    <td className="pr-3 align-top">
                      <Chip status={row.snapshots.status} probableHoliday={row.probableHoliday} notCollected={data.sourcesNotCollected.includes("snapshots")} />
                      <span className="ml-2">{snapshotCountText(row.snapshots)}</span>
                      <span className="block text-[10px] text-slate-500">
                        {istSpan(row.snapshots.firstAt, row.snapshots.lastAt)} IST
                        {row.snapshots.preOpenMinutes + row.snapshots.postCloseMinutes > 0 ? ` · ${row.snapshots.preOpenMinutes} pre-open, ${row.snapshots.postCloseMinutes} post-close set aside` : ""}
                      </span>
                    </td>
                    <td className="pr-3 align-top">
                      <Chip status={row.depth.status} probableHoliday={row.probableHoliday} notCollected={data.sourcesNotCollected.includes("depth")} />
                      <span className="ml-2">{depthFramesText(row.depth)}</span>
                      <span className="block text-[10px] text-slate-500">{istSpan(row.depth.firstAt, row.depth.lastAt)} IST{row.depth.symbol ? ` · ${row.depth.symbol.replace("NSE:", "").replace(/FUT$/, " fut")}` : ""}</span>
                    </td>
                    <td className="max-w-[360px] align-top">
                      {row.probableHoliday ? "probable holiday" : row.gapInSource && !row.inProgress ? <span className="text-amber-200">gap in a source</span> : ""}
                      {collectorSentences(row).map((sentence) => (
                        <span key={sentence} className="mt-0.5 block text-[10px] text-slate-500">{sentence}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3 text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Definitions and thresholds</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries({ ...data.definitions, ...data.collectorDefinitions }).map(([name, text]) => (
                <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
              ))}
            </dl>
            <p className="mt-2">{data.source}. Weekdays only; {data.typicalSnapshotMinutes === null ? "no typical snapshot day yet" : `the typical snapshot day is ${data.typicalSnapshotMinutes} in-session runs`}.</p>
          </details>
          <p className="mt-2 text-[11px] text-slate-500">
            A status is a stated threshold on a count, not a judgement of quality. Whether a view can be trusted for a given day depends on what it needs: the page of that view says so.
          </p>
        </>
      )}
    </div>
  );
}
