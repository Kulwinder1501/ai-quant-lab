"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getResearchJson } from "../../research/api";

interface ExpiryRow {
  id: string;
  title: string;
  kind: string;
  dateLabel: string;
  daysAway: number;
}

interface HeadlineRow {
  id: string;
  title: string;
}

interface ScheduledRow {
  id: string;
  title: string;
  dateLabel: string;
  region: string;
}

interface OptionChainResponse {
  data?: {
    available?: boolean;
    underlyingSymbol?: string;
    expiries?: Array<{ expiryDate: string; expiryKind: string }>;
  };
}

interface MacroEventsResponse {
  data?: {
    hasMacroEvent?: boolean;
    events?: string[];
    hasScheduledEvent?: boolean;
    scheduledEvents?: Array<{ eventDate: string; name: string; region: string; source: string; sourceUrl: string | null; verified: true }>;
    upcomingScheduledEvents?: Array<{ eventDate: string; name: string; region: string; source: string; sourceUrl: string | null; verified: true }>;
    hasHeadlineHeat?: boolean;
    headlineEvents?: string[];
  };
}

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

function daysUntilIstDate(isoDate: string, now = new Date()): number | null {
  // Expiry dates are calendar days in IST settlement terms (YYYY-MM-DD).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expiryUtc = Date.UTC(year, month - 1, day, 10, 0, 0); // ~15:30 IST
  const nowUtc = now.getTime();
  return Math.ceil((expiryUtc - nowUtc) / (24 * 60 * 60 * 1000));
}

function formatDayAway(days: number): string {
  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

/**
 * Upcoming items from listed option expiries, dated scheduled macro events,
 * and keyword headline heat (soft only).
 */
export function UpcomingEvents() {
  const [expiries, setExpiries] = useState<ExpiryRow[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledRow[]>([]);
  const [headlines, setHeadlines] = useState<HeadlineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [macro, ...chains] = await Promise.all([
          getResearchJson("/macro-events") as Promise<MacroEventsResponse>,
          ...UNDERLYINGS.map(
            (underlying) =>
              getResearchJson(`/option-chain?underlying=${underlying}`) as Promise<OptionChainResponse>,
          ),
        ]);

        if (cancelled) return;

        const nextExpiries: ExpiryRow[] = [];
        for (const response of chains) {
          const payload = response?.data;
          if (!payload?.available || !Array.isArray(payload.expiries)) continue;
          const symbol = payload.underlyingSymbol ?? "INDEX";
          for (const entry of payload.expiries) {
            if (!entry?.expiryDate) continue;
            const daysAway = daysUntilIstDate(entry.expiryDate);
            if (daysAway === null || daysAway < 0) continue;
            nextExpiries.push({
              id: `${symbol}-${entry.expiryDate}`,
              title: `${symbol} ${entry.expiryKind === "WEEKLY" ? "weekly" : "monthly"} expiry`,
              kind: entry.expiryKind || "LISTED",
              dateLabel: entry.expiryDate,
              daysAway,
            });
          }
        }
        nextExpiries.sort((a, b) => a.daysAway - b.daysAway || a.dateLabel.localeCompare(b.dateLabel));
        setExpiries(nextExpiries.slice(0, 6));

        const scheduledRows = Array.isArray(macro?.data?.upcomingScheduledEvents)
          ? macro.data.upcomingScheduledEvents
          : Array.isArray(macro?.data?.scheduledEvents)
            ? macro.data.scheduledEvents
          : [];
        setScheduled(
          scheduledRows.slice(0, 6).map((event, index) => ({
            id: `scheduled-${event.eventDate}-${index}`,
            title: event.name,
            dateLabel: event.eventDate,
            region: event.region,
          })),
        );

        const titles = Array.isArray(macro?.data?.headlineEvents)
          ? macro.data.headlineEvents
          : Array.isArray(macro?.data?.events) && !macro.data.hasScheduledEvent
            ? macro.data.events
            : [];
        setHeadlines(
          titles.slice(0, 4).map((title, index) => ({
            id: `macro-${index}`,
            title,
          })),
        );
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load events.");
          setExpiries([]);
          setScheduled([]);
          setHeadlines([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(() => {
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const empty = expiries.length === 0 && scheduled.length === 0 && headlines.length === 0;

  return (
    <GlassPanel className="flex h-full flex-col rounded-md border-white/5 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-center justify-between border-b border-white/5 pb-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          <span className="flex h-3 w-3 items-center justify-center text-[10px]">📅</span>
          Upcoming
        </h3>
        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-600">
          calendar + headlines
        </span>
      </div>

      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto pr-1">
        {loading && (
          <p className="py-4 text-center text-[10px] italic text-slate-500">Loading…</p>
        )}

        {!loading && error && (
          <p className="py-4 text-center text-[10px] text-rose-400/80">{error}</p>
        )}

        {!loading && !error && empty && (
          <div className="space-y-2 py-4 text-center">
            <p className="text-[10px] font-bold text-slate-400">No upcoming items yet</p>
            <p className="text-[9px] leading-relaxed text-slate-600">
              No listed option expiries, scheduled macro events, or headline matches in store.
            </p>
          </div>
        )}

        {!loading && scheduled.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[8px] font-black uppercase tracking-widest text-amber-500/80">
              Verified scheduled macro
            </h4>
            {scheduled.map((evt) => (
              <div
                key={evt.id}
                className="border-b border-white/[0.02] pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <h5 className="truncate text-xs font-bold text-slate-200">{evt.title}</h5>
                  <span className="shrink-0 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-black tracking-wider text-amber-300">
                    {evt.region}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10px] text-slate-400">{evt.dateLabel}</div>
              </div>
            ))}
          </section>
        )}

        {!loading && expiries.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[8px] font-black uppercase tracking-widest text-slate-500">
              Option expiries
            </h4>
            {expiries.map((evt) => (
              <div
                key={evt.id}
                className="border-b border-white/[0.02] pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <h5 className="truncate text-xs font-bold text-slate-200">{evt.title}</h5>
                  <span className="shrink-0 rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[8px] font-black tracking-wider text-cyan-300">
                    {evt.kind}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-slate-400">
                  <span>{evt.dateLabel}</span>
                  <span className="font-bold text-cyan-400">{formatDayAway(evt.daysAway)}</span>
                </div>
              </div>
            ))}
          </section>
        )}

        {!loading && headlines.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[8px] font-black uppercase tracking-widest text-slate-500">
              Macro headlines (soft only)
            </h4>
            {headlines.map((row) => (
              <div
                key={row.id}
                className="border-b border-white/[0.02] pb-2 last:border-0 last:pb-0"
              >
                <p className="text-[11px] leading-snug text-slate-300">{row.title}</p>
              </div>
            ))}
          </section>
        )}
      </div>
    </GlassPanel>
  );
}
