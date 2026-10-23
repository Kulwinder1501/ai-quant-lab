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

export function SnapshotFreshnessBar(props: {
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  nowMs: number;
}) {
  const { observedAt, provider, expiryLabel, nowMs } = props;
  const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  const assessment = assessOiSnapshotFreshness({
    observedAtMs: Number.isFinite(observedMs) ? observedMs : null,
    nowMs,
  });
  const copy = freshnessCopy(assessment.state);
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
          Snapshot, not live
        </span>
        <span>
          Observed{" "}
          <span className="font-mono text-slate-100">
            {Number.isFinite(observedMs) ? `${formatClock(observedAt!)} IST` : "—"}
          </span>
          {assessment.ageMs !== null && (
            <span className={copy.tone === "warn" ? "ml-2 font-bold text-amber-200" : "ml-2 text-slate-400"}>
              ({formatAge(assessment.ageMs)}
              {assessment.state === "in_session_stale" ? " · in-session stale" : ""}
              {assessment.state === "outside_collection_hours" ? " · outside hours" : ""})
            </span>
          )}
        </span>
        <span className="text-slate-500">·</span>
        <span>Provider {provider ?? "—"}</span>
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
        <p className="mt-1 text-[11px] text-amber-200/90">
          Pre-open carryover: this snapshot was observed before 09:15 IST. Open interest is the
          previous session&apos;s close echoed before the exchange publishes a fresh book — change
          will read as zero until the next intraday collect.
        </p>
      )}
    </div>
  );
}
