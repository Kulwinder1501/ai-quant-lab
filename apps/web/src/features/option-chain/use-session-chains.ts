import { useEffect, useState } from "react";
import { errorMessage, isAbortError } from "../../lib/errors";
import { getApiV1Url } from "../research/api";
import type { ChainResponse } from "./live-chain";

/** The chain stored at the last in-session snapshot of one trading session, or why it could not be read. */
export interface SessionChain {
  sessionDate: string;
  observedAt: string;
  chain: ChainResponse | null;
  error: string | null;
}

interface SessionsPayload {
  sessions: Array<{ sessionDate: string; observedAt: string }>;
  days: number;
  dayChoices: number[];
}

export interface LoadedSessionChains {
  key: string;
  sessions: SessionChain[] | null;
  dayChoices: number[];
  error: string | null;
}

/** Chains are read a few at a time so ten sessions do not open ten requests at once. */
const CONCURRENCY = 3;

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json() as { data: T }).data;
}

/**
 * The stored chain of the last in-session snapshot of each of the newest sessions: the sessions are listed
 * (`/option-chain/session-snapshots`), then each chain is read as of its snapshot (`/option-chain?asOf=`). One read serves every view
 * that sets sessions side by side. `current` is null while loading or after the underlying or day count changed.
 */
export function useSessionChains(underlying: string): { days: number | null; setDays: (days: number) => void; current: LoadedSessionChains | null } {
  const [days, setDays] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<LoadedSessionChains | null>(null);
  const key = `${underlying}|${days ?? "default"}`;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams({ underlying, ...(days !== null ? { days: String(days) } : {}) });
        const listing = await readJson<SessionsPayload>(`${getApiV1Url()}/option-chain/session-snapshots?${params.toString()}`, controller.signal);
        const results: SessionChain[] = new Array(listing.sessions.length);
        let next = 0;
        const worker = async () => {
          while (next < listing.sessions.length) {
            const index = next;
            next += 1;
            const session = listing.sessions[index]!;
            try {
              const chainParams = new URLSearchParams({ underlying, asOf: session.observedAt });
              const chain = await readJson<ChainResponse>(`${getApiV1Url()}/option-chain?${chainParams.toString()}`, controller.signal);
              results[index] = chain.available === false || !chain.strikes
                ? { ...session, chain: null, error: chain.reason ?? "No chain is stored." }
                : { ...session, chain, error: null };
            } catch (caught) {
              if (isAbortError(caught)) throw caught;
              results[index] = { ...session, chain: null, error: errorMessage(caught, "The chain could not be read.") };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listing.sessions.length) }, worker));
        setLoaded({ key, sessions: results, dayChoices: listing.dayChoices, error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setLoaded({ key, sessions: null, dayChoices: [], error: errorMessage(caught, "The sessions could not be listed.") });
      }
    })();
    return () => controller.abort();
  }, [underlying, days, key]);

  return { days, setDays, current: loaded?.key === key ? loaded : null };
}
