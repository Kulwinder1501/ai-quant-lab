"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { PageHeader } from "../../../components/layout/page-header";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Tabs } from "../../../components/ui/tabs";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { formatIstDate } from "../../../lib/ist-date";
import { getApiV1Url } from "../../research/api";
import {
  buildLadder,
  confluenceText,
  excludesZero,
  familyLabel,
  formatCalendarDate,
  formatDifference,
  formatDistance,
  formatPrice,
  formatShare,
  formatZoneRange,
  sheetFreshness,
  type HistoryComparison,
  type SheetZone,
} from "../levels-view";

const UNDERLYINGS = [
  { id: "NIFTY50", label: "NIFTY 50" },
  { id: "BANKNIFTY", label: "BANK NIFTY" },
] as const;

type Underlying = (typeof UNDERLYINGS)[number]["id"];

interface History {
  studyVersion: string;
  computedAt: string;
  windowFrom: string;
  windowTo: string;
  sessionsUsed: number;
  sessionsSkipped: number;
  comparisons: HistoryComparison[];
  confluence: HistoryComparison | null;
  caveat: string;
}

interface SheetBody {
  available: true;
  underlying: Underlying;
  sessionDate: string;
  referenceDate: string;
  referencePrice: number;
  version: number;
  generatedAt: string;
  zones: SheetZone[];
  unavailable: Array<{ family: string; reason: string }>;
  oi: { observedAt: string | null; expiry: string | null } | null;
  history: History | null;
  disclaimer: string;
}

interface EmptyBody {
  available: false;
  underlying: Underlying;
  reason: string;
  disclaimer: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; body: SheetBody | EmptyBody };

const timeFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

/** Loads the stored sheet for one index; the state is keyed by the index so a tab change never shows the previous index's sheet. */
function useDailyLevels(underlying: Underlying): LoadState {
  const [loaded, setLoaded] = useState<{ key: Underlying; state: LoadState } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/daily-levels?underlying=${underlying}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status}).`);
        }
        const payload = await response.json() as { data: SheetBody | EmptyBody };
        setLoaded({ key: underlying, state: { status: "ready", body: payload.data } });
      } catch (error) {
        if (isAbortError(error)) return;
        setLoaded({ key: underlying, state: { status: "error", message: errorMessage(error, "The levels could not be loaded.") } });
      }
    })();
    return () => controller.abort();
  }, [underlying]);

  return loaded !== null && loaded.key === underlying ? loaded.state : { status: "loading" };
}

function SourceChips({ zone }: { zone: SheetZone }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {zone.levels.map((level) => (
        <span
          className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-xs text-slate-300"
          key={`${level.family}-${level.key}`}
          title={`${familyLabel(level.family)}: ${level.label} at ${formatPrice(level.price)}${level.note ? ` (${level.note})` : ""}`}
        >
          {level.label}
          {level.note ? ` · ${level.note}` : ""}
        </span>
      ))}
    </div>
  );
}

function Ladder({ body }: { body: SheetBody }) {
  const rows = useMemo(() => buildLadder(body.zones, body.referencePrice), [body.zones, body.referencePrice]);
  return (
    <GlassPanel className="overflow-x-auto p-0">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-4 py-3 font-semibold">Zone</th>
            <th className="px-4 py-3 font-semibold">From previous close</th>
            <th className="px-4 py-3 font-semibold">Agreement</th>
            <th className="px-4 py-3 font-semibold">Lines in the zone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === "REFERENCE" ? (
              <tr className="border-t border-cyan-400/40 bg-cyan-400/10" key="reference">
                <td className="px-4 py-2 font-semibold text-cyan-100" colSpan={4}>
                  Previous close {formatPrice(row.price)} ({formatCalendarDate(body.referenceDate)})
                </td>
              </tr>
            ) : (
              <tr className="border-t border-slate-800 align-top" key={`${row.zone.low}-${row.zone.high}`}>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">{formatZoneRange(row.zone)}</td>
                <td className={`whitespace-nowrap px-4 py-3 ${row.zone.position === "ABOVE" ? "text-emerald-300" : row.zone.position === "BELOW" ? "text-rose-300" : "text-slate-300"}`}>
                  {formatDistance(row.zone)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                  {confluenceText(row.zone)}
                  {row.zone.confluence > 1 ? <span className="block text-xs text-slate-500">{row.zone.families.map(familyLabel).join(" + ")}</span> : null}
                </td>
                <td className="px-4 py-3"><SourceChips zone={row.zone} /></td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </GlassPanel>
  );
}

function HistoryTable({ history }: { history: History }) {
  const rows = [...history.comparisons, ...(history.confluence ? [history.confluence] : [])];
  return (
    <GlassPanel className="space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold text-white">How these levels behaved against random lines</h2>
        <p className="mt-1 text-sm text-slate-300">
          {history.sessionsUsed} sessions, {formatCalendarDate(history.windowFrom)} {history.windowFrom.slice(0, 4)} to {formatCalendarDate(history.windowTo)} {history.windowTo.slice(0, 4)}.
          After price first touched a line, how often did it move 0.25% away from it before moving 0.25% through it (a bounce)?
          Open-interest walls cannot be replayed, so they are not in this table.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="py-2 pr-4 font-semibold">Levels</th>
              <th className="py-2 pr-4 font-semibold">Bounced</th>
              <th className="py-2 pr-4 font-semibold">Random lines</th>
              <th className="py-2 pr-4 font-semibold">Difference, points (95% range)</th>
              <th className="py-2 font-semibold">Reading</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-slate-800 align-top" key={row.family}>
                <td className="py-2 pr-4 text-slate-200">{familyLabel(row.family)}</td>
                <td className="py-2 pr-4 text-slate-300">{formatShare(row.realBounceShare)} <span className="text-xs text-slate-500">of {row.realResolved}</span></td>
                <td className="py-2 pr-4 text-slate-300">
                  {row.family === "CONFLUENCE_2_PLUS_VS_1" ? `${formatShare(row.placeboBounceShare)} (single-source)` : formatShare(row.placeboBounceShare)}
                  <span className="text-xs text-slate-500"> of {row.placeboResolved}</span>
                </td>
                <td className="whitespace-nowrap py-2 pr-4 text-slate-300">{formatDifference(row)}</td>
                <td className={`py-2 ${excludesZero(row) ? "text-amber-200" : "text-slate-400"}`}>{row.sentence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{history.caveat}</p>
    </GlassPanel>
  );
}

function SheetView({ body }: { body: SheetBody }) {
  const freshness = sheetFreshness(body.sessionDate, formatIstDate(new Date()));
  const generated = timeFormatter.format(new Date(body.generatedAt));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-300">
        <span className={freshness.state === "OLD" ? "font-semibold text-amber-200" : ""}>{freshness.text}</span>
        <span>Built from the close of {formatCalendarDate(body.referenceDate)} ({formatPrice(body.referencePrice)}).</span>
        <span>Version {body.version}, generated {generated} IST.</span>
        {body.oi ? <span>Option walls: expiry {body.oi.expiry ?? "unknown"}.</span> : null}
      </div>
      {body.unavailable.length > 0 ? (
        <p className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
          Not in this sheet: {body.unavailable.map((item) => `${familyLabel(item.family)} (${item.reason})`).join("; ")}.
        </p>
      ) : null}
      <Ladder body={body} />
      <p className="text-xs leading-relaxed text-slate-400">
        Two lines built from the same day&apos;s bar (a pivot and the previous high) are counted as two sources here, but they are not independent
        confirmation. Zones group lines within 0.10% of each other.
      </p>
      {body.history ? <HistoryTable history={body.history} /> : (
        <GlassPanel className="p-5 text-sm text-slate-300">No reaction study has been stored yet, so there is no history to show beside these levels.</GlassPanel>
      )}
    </div>
  );
}

export function DailyLevelsPage() {
  const [underlying, setUnderlying] = useState<Underlying>("NIFTY50");
  const state = useDailyLevels(underlying);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Markets"
        title="Daily Levels"
        description="The price levels traders commonly watch for NIFTY and BANKNIFTY, computed from stored data before the open and grouped where several agree."
      />
      <GlassPanel className="border-amber-400/40 p-4 text-sm leading-relaxed text-amber-100">
        {state.status === "ready" ? state.body.disclaimer : "Context, not a signal. These levels do not say price will bounce, and no bot reads them."}
      </GlassPanel>
      <Tabs
        activeId={underlying}
        onChange={(id) => setUnderlying(id as Underlying)}
        tabs={UNDERLYINGS.map((item) => ({ id: item.id, label: item.label }))}
      />
      {state.status === "loading" ? <p className="text-sm text-slate-400">Loading the sheet...</p> : null}
      {state.status === "error" ? (
        <GlassPanel className="flex items-start gap-3 border-rose-400/40 p-4 text-sm text-rose-100">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>Could not load the levels: {state.message}</span>
        </GlassPanel>
      ) : null}
      {state.status === "ready" && !state.body.available ? (
        <GlassPanel className="p-5 text-sm text-slate-300">{state.body.reason}</GlassPanel>
      ) : null}
      {state.status === "ready" && state.body.available ? <SheetView body={state.body} /> : null}
    </div>
  );
}
