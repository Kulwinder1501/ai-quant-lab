"use client";

import React from "react";
import {
  assessOiSnapshotFreshness,
  type OiFreshnessState,
} from "../oi-snapshot-freshness";

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}

function freshnessCopy(state: OiFreshnessState): { tone: "ok" | "warn" | "idle"; detail: string | null } {
  switch (state) {
    case "in_session_fresh":
      return { tone: "ok", detail: null };
    case "in_session_stale":
      return {
        tone: "warn",
        detail:
          "In-session snapshot older than 20 minutes (collector gaps alternate 12/18 minutes Mon–Fri 09:11–15:53 IST). Treat levels as delayed until the next successful collect.",
      };
    case "outside_collection_hours":
      return {
        tone: "idle",
        detail:
          "Outside collection hours (Mon–Fri 09:11–15:53 IST). Age is expected overnight and on weekends; this is not an in-session delay. Holidays are not detected.",
      };
  }
}

/**
 * What a pre-open (before 09:15 IST) snapshot means *for a given tab*. The caveat differs: for open
 * interest the 09:11 row is yesterday's close echoed back (measured: OI equals previous OI on 100%
 * of NIFTY/BANKNIFTY rows); for quotes the contracts are quoted but wide, so anything solved from a
 * mid is noisier. One shared sentence would be wrong on one of the two tabs.
 */
export const PRE_OPEN_NOTE_OPEN_INTEREST =
  "Pre-open carryover: this snapshot was observed before 09:15 IST. Open interest is the previous session's close echoed before the exchange publishes a fresh book — change will read as zero until the next intraday collect.";

export const PRE_OPEN_NOTE_QUOTES =
  "Pre-open snapshot: observed before 09:15 IST. Option quotes are two-sided but wide (measured on NIFTY over 30 days: median spread about 1.3% of mid at 09:11 versus 0.4% intraday), so IV and Greeks solved from these mids are noisier than later in the session.";

export function SnapshotFreshnessBar(props: {
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  nowMs: number;
  /** Tab-specific wording shown when the snapshot is a pre-open one. Defaults to the open-interest note. */
  preOpenNote?: string;
  /**
   * True when the data is a past session picked from history. Snapshot age only means "delay" for the
   * live session; a week-old stored day reported as "in-session stale" would be a false alarm, so the
   * assessment is skipped and the bar says what it is showing.
   */
  historical?: boolean;
}) {
  const { observedAt, provider, expiryLabel, nowMs, preOpenNote = PRE_OPEN_NOTE_OPEN_INTEREST, historical = false } = props;
  const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  const assessment = assessOiSnapshotFreshness({
    observedAtMs: Number.isFinite(observedMs) ? observedMs : null,
    nowMs,
  });
  const copy: { tone: "ok" | "warn" | "idle"; detail: string | null } = historical
    ? {
      tone: "idle",
      detail: "Historical session: these are stored snapshots from a past day, so their age is not a delay.",
    }
    : freshnessCopy(assessment.state);
  const toneClass =
    copy.tone === "warn"
      ? "border-amber-400/40 bg-amber-500/10 text-amber-100"
      : copy.tone === "idle"
        ? "border-slate-500/30 bg-slate-900/60 text-slate-300"
        : "border-white/10 bg-slate-950/50 text-slate-300";

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2 text-xs ${toneClass}`} role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold uppercase tracking-wider text-[10px] text-slate-400">
          {historical ? "Stored session" : "Snapshot, not live"}
        </span>
        <span>
          {historical ? "Last observed" : "Observed"}{" "}
          <span className="font-mono text-slate-100">
            {Number.isFinite(observedMs) ? `${formatClock(observedAt!)} IST` : "—"}
          </span>
          {!historical && assessment.ageMs !== null && (
            <span className={copy.tone === "warn" ? "ml-2 font-bold text-amber-200" : "ml-2 text-slate-400"}>
              ({formatAge(assessment.ageMs)}
              {assessment.state === "in_session_stale" ? " · in-session stale" : ""}
              {assessment.state === "outside_collection_hours" ? " · outside hours" : ""})
            </span>
          )}
        </span>
        {provider !== undefined && (
          <>
            <span className="text-slate-500">·</span>
            <span>Provider {provider ?? "—"}</span>
          </>
        )}
        <span className="text-slate-500">·</span>
        <span>Expiry {expiryLabel?.trim() ? expiryLabel : "—"}</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Option-chain history accumulates forward only — there is no historical source to backfill from.
      </p>
      {copy.detail && (
        <p className={`mt-1 text-[11px] ${copy.tone === "warn" ? "text-amber-200/90" : "text-slate-400"}`}>
          {copy.detail}
        </p>
      )}
      {assessment.preOpenOiCarryover && (
        <p className="mt-1 text-[11px] text-amber-200/90">{preOpenNote}</p>
      )}
    </div>
  );
}
