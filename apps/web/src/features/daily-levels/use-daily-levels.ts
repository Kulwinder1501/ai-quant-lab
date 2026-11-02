"use client";

import { useEffect, useState } from "react";
import { errorMessage, isAbortError } from "../../lib/errors";
import { getApiV1Url } from "../research/api";
import type { HistoryComparison, SheetZone } from "./levels-view";

export type Underlying = "NIFTY50" | "BANKNIFTY";

/** The two indices the sheet is built for. Anything else has no levels. */
export function isLevelsUnderlying(symbol: string): symbol is Underlying {
  return symbol === "NIFTY50" || symbol === "BANKNIFTY";
}

export interface History {
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

export interface SheetBody {
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

export interface EmptyBody {
  available: false;
  underlying: Underlying;
  reason: string;
  disclaimer: string;
}

export type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; body: SheetBody | EmptyBody };

/** A dashboard left open across 08:55 should pick the new sheet up without a reload. */
const REFRESH_MS = 10 * 60_000;

/**
 * Loads the stored sheet for one index, `idle` for no index. The state is keyed by the index so a change never shows the previous index's
 * sheet, and a failed background refresh keeps the sheet already on screen instead of replacing it with an error.
 */
export function useDailyLevels(underlying: Underlying | null): LoadState {
  const [loaded, setLoaded] = useState<{ key: Underlying; state: LoadState } | null>(null);

  useEffect(() => {
    if (underlying === null) return;
    const controller = new AbortController();
    const load = async (isRefresh: boolean) => {
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
        if (isAbortError(error) || isRefresh) return;
        setLoaded({ key: underlying, state: { status: "error", message: errorMessage(error, "The levels could not be loaded.") } });
      }
    };
    void load(false);
    const interval = setInterval(() => { void load(true); }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [underlying]);

  if (underlying === null) return { status: "idle" };
  return loaded !== null && loaded.key === underlying ? loaded.state : { status: "loading" };
}
