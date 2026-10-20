"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  Clock,
  ExternalLink,
  GitBranch,
  History,
  PenSquare,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { createManualEvent, editManualEvent, fetchEquityEvents } from "../api";
import {
  MANUAL_EVENT_KINDS,
  type EventFlagRecord,
  type ManualEventKind,
  type WatchlistStockItem,
} from "../types";

interface EquityEventsPanelProps {
  stock: WatchlistStockItem;
  onEventCreated?: () => void;
}

export function EquityEventsPanel({
  stock,
  onEventCreated,
}: EquityEventsPanelProps) {
  const [events, setEvents] = useState<EventFlagRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [includeHistory, setIncludeHistory] = useState<boolean>(false);

  // Form State
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [editingEvent, setEditingEvent] = useState<EventFlagRecord | null>(null);

  // Add Form Inputs
  const [formKind, setFormKind] = useState<ManualEventKind>("RESULTS_DATE_UPCOMING");
  const [formDate, setFormDate] = useState<string>(
    new Date().toISOString().split("T")[0],
  );
  const [formHeadline, setFormHeadline] = useState<string>("");
  const [formSourceUrl, setFormSourceUrl] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const loadEvents = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetchEquityEvents({
        stockId: stock.id,
        includeHistory,
      });
      setEvents(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load events.";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [stock.id, includeHistory]);

  useEffect(() => {
    let isMounted = true;
    void fetchEquityEvents({
      stockId: stock.id,
      includeHistory,
    })
      .then((res) => {
        if (isMounted) {
          setEvents(res);
          setError(null);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load events.");
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [stock.id, includeHistory]);

  const supersededIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) {
      if (e.supersedes_id) {
        set.add(e.supersedes_id);
      }
    }
    return set;
  }, [events]);

  const handleOpenAdd = () => {
    setEditingEvent(null);
    setFormKind("RESULTS_DATE_UPCOMING");
    setFormDate(new Date().toISOString().split("T")[0]);
    setFormHeadline("");
    setFormSourceUrl("");
    setFormError(null);
    setShowAddForm(true);
  };

  const handleOpenEdit = (event: EventFlagRecord) => {
    setEditingEvent(event);
    setFormKind(
      MANUAL_EVENT_KINDS.includes(event.kind as ManualEventKind)
        ? (event.kind as ManualEventKind)
        : "OTHER",
    );
    setFormDate(event.event_date);
    setFormHeadline(event.headline);
    setFormSourceUrl(event.source_url ?? "");
    setFormError(null);
    setShowAddForm(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedUrl = formSourceUrl.trim();
    if (!trimmedUrl.toLowerCase().startsWith("https://") || trimmedUrl.length <= 8) {
      setFormError("Valid https link is required (e.g. https://www.bseindia.com/...)");
      return;
    }

    if (!formHeadline.trim()) {
      setFormError("Headline is required.");
      return;
    }

    if (formHeadline.trim().length > 200) {
      setFormError("Headline must be 200 characters or fewer.");
      return;
    }

    try {
      setIsSubmitting(true);
      if (editingEvent) {
        // Edit existing -> creates revision
        await editManualEvent(editingEvent.id, {
          headline: formHeadline.trim(),
          sourceUrl: trimmedUrl,
          kind: formKind,
          eventDate: formDate,
        });
      } else {
        // Create new manual event
        await createManualEvent({
          stockId: stock.id,
          kind: formKind,
          eventDate: formDate,
          headline: formHeadline.trim(),
          sourceUrl: trimmedUrl,
        });
      }

      setShowAddForm(false);
      setEditingEvent(null);
      await loadEvents();
      if (onEventCreated) {
        onEventCreated();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to record event.";
      setFormError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getKindBadgeClass = (kind: string, origin: string) => {
    if (origin === "DETECTED") {
      return "bg-cyan-500/10 text-cyan-300 border-cyan-500/20";
    }
    switch (kind) {
      case "MATERIAL_NEGATIVE":
        return "bg-rose-500/10 text-rose-300 border-rose-500/20";
      case "ORDER_WIN":
        return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
      case "RESULTS_DATE_UPCOMING":
        return "bg-purple-500/10 text-purple-300 border-purple-500/20";
      case "REGULATORY":
        return "bg-amber-500/10 text-amber-300 border-amber-500/20";
      case "MANAGEMENT":
        return "bg-blue-500/10 text-blue-300 border-blue-500/20";
      default:
        return "bg-slate-500/10 text-slate-300 border-slate-500/20";
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-3">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={(e) => setIncludeHistory(e.target.checked)}
              className="rounded border-white/20 bg-slate-900 text-cyan-500 focus:ring-0"
            />
            <History className="size-3.5 text-slate-400" />
            <span>Include revision history</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadEvents()}
            disabled={isLoading}
            className="rounded-lg border border-white/10 bg-slate-900/60 p-1.5 text-slate-400 hover:text-white transition disabled:opacity-50"
            title="Refresh events"
          >
            <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
          </button>
          {!showAddForm && (
            <button
              type="button"
              onClick={handleOpenAdd}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/30 transition"
            >
              <Plus className="size-3.5" />
              Add Event
            </button>
          )}
        </div>
      </div>

      {/* Add / Edit Form */}
      {showAddForm && (
        <form
          onSubmit={handleFormSubmit}
          className="rounded-xl border border-cyan-500/30 bg-slate-900/90 p-4 space-y-3"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <h4 className="text-xs font-semibold text-white flex items-center gap-1.5">
              <PenSquare className="size-3.5 text-cyan-400" />
              {editingEvent ? "Edit Event (Creates Revision)" : "Record Manual Event"}
            </h4>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingEvent(null);
              }}
              className="text-slate-400 hover:text-white p-1 rounded"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {formError && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-2.5 text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="size-4 shrink-0 text-rose-400 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {/* Category / Kind */}
            <div>
              <label className="block text-slate-400 text-[11px] mb-1">
                Category
              </label>
              <select
                value={formKind}
                onChange={(e) => setFormKind(e.target.value as ManualEventKind)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500"
              >
                {MANUAL_EVENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>

            {/* Event Date */}
            <div>
              <label className="block text-slate-400 text-[11px] mb-1">
                Event Date (YYYY-MM-DD)
              </label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                required
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Headline */}
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <label className="text-slate-400">Headline</label>
              <span
                className={`font-mono text-[10px] ${
                  formHeadline.length > 200 ? "text-rose-400" : "text-slate-500"
                }`}
              >
                {formHeadline.length} / 200
              </span>
            </div>
            <input
              type="text"
              value={formHeadline}
              onChange={(e) => setFormHeadline(e.target.value)}
              placeholder="e.g. Q2 results date announced for Nov 14"
              maxLength={200}
              required
              className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500 placeholder:text-slate-600"
            />
          </div>

          {/* Source Link (Required https) */}
          <div>
            <label className="block text-slate-400 text-[11px] mb-1">
              Source Link (https:// required)
            </label>
            <input
              type="url"
              value={formSourceUrl}
              onChange={(e) => setFormSourceUrl(e.target.value)}
              placeholder="https://www.bseindia.com/..."
              required
              className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500 placeholder:text-slate-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingEvent(null);
              }}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition disabled:opacity-50"
            >
              {isSubmitting ? "Saving..." : editingEvent ? "Save Revision" : "Add Event"}
            </button>
          </div>
        </form>
      )}

      {/* Events List Body */}
      <div className="space-y-3">
        {/* Loading State */}
        {isLoading && (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-white/5 bg-slate-900/40 p-4 space-y-2"
              >
                <div className="h-4 w-28 bg-slate-800 rounded" />
                <div className="h-4 w-3/4 bg-slate-800 rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 p-6 text-center text-rose-300">
            <AlertCircle className="size-6 text-rose-400 mb-2" />
            <p className="text-xs">{error}</p>
            <button
              type="button"
              onClick={() => void loadEvents()}
              className="mt-3 rounded-lg bg-rose-500/20 px-3 py-1 text-xs font-semibold text-rose-200 border border-rose-500/30"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && events.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-white/5 bg-slate-900/20 p-8 text-center text-slate-400">
            <Calendar className="size-6 text-slate-500 mb-2" />
            <p className="text-xs">No event flags recorded for this stock.</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Add upcoming results dates or corporate events with an official link.
            </p>
          </div>
        )}

        {/* Populated State */}
        {!isLoading &&
          !error &&
          events.map((event) => (
            <div
              key={event.id}
              className="rounded-xl border border-white/10 bg-slate-900/60 p-3.5 space-y-2 transition hover:border-white/20"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-mono text-[11px] text-slate-400 flex items-center gap-1">
                    <Clock className="size-3 text-slate-500" />
                    {event.event_date}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${getKindBadgeClass(
                      event.kind,
                      event.origin,
                    )}`}
                  >
                    {event.kind.replace(/_/g, " ")}
                  </span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-white/5">
                    {event.origin}
                  </span>
                  {event.supersedes_id && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/90 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                      <GitBranch className="size-3" />
                      Revision
                    </span>
                  )}
                </div>

                {event.origin === "MANUAL" && !supersededIds.has(event.id) && (
                  <button
                    type="button"
                    onClick={() => handleOpenEdit(event)}
                    className="inline-flex items-center gap-1 rounded bg-slate-800/80 px-2 py-0.5 text-[11px] text-slate-300 hover:text-white hover:bg-slate-700 transition border border-white/10"
                  >
                    <PenSquare className="size-3" />
                    Edit
                  </button>
                )}
                {supersededIds.has(event.id) && (
                  <span className="text-[10px] text-slate-500 font-mono italic">
                    Superseded
                  </span>
                )}
              </div>

              {/* Headline */}
              <p className="text-xs font-medium text-slate-100 leading-snug">
                {event.headline}
              </p>

              {/* Source Link (rendered with rel="noopener noreferrer") */}
              {event.source_url && (
                <div className="pt-1">
                  <a
                    href={event.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    <span className="truncate max-w-sm">Source link</span>
                  </a>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
