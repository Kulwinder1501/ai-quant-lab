"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '../../../components/layout/page-header';
import { GlassPanel } from '../../../components/ui/glass-panel';
import { MarketLoader } from '../../../components/ui/market-loader';
import { Select } from '../../../components/ui/select';
import { ThemeToggle } from '../../../components/theme/theme-toggle';
import { useAppStore } from '../../../stores/app-store';
import { getApiV1Url } from '../../research/api';

const INSTRUMENT_OPTIONS = [
  { value: 'NIFTY50', label: 'NIFTY 50' },
  { value: 'BANKNIFTY', label: 'NIFTY BANK' },
  { value: 'RELIANCE', label: 'RELIANCE' },
  { value: 'HDFCBANK', label: 'HDFC BANK' },
  { value: 'INFY', label: 'INFOSYS' },
];

const TIMEFRAME_OPTIONS = [
  { value: '1m', label: '1 Minute' },
  { value: '5m', label: '5 Minutes' },
  { value: '15m', label: '15 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '1d', label: '1 Day' },
];

type FyersHealthStatus = 'OK' | 'EXPIRING_SOON' | 'ERROR' | 'EXPIRED' | 'MISSING';

interface FyersHealthResponse {
  status?: FyersHealthStatus;
  reasons?: string[];
  accessTokenExpiresAt?: string | null;
  lastError?: string | null;
  recoveryHint?: string;
}

function statusBadgeClass(status: FyersHealthStatus | 'UNKNOWN'): string {
  switch (status) {
    case 'OK':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'EXPIRING_SOON':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'ERROR':
    case 'EXPIRED':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
    case 'MISSING':
    default:
      return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
  }
}

function needsReconnect(status: FyersHealthStatus | 'UNKNOWN'): boolean {
  return status === 'MISSING' || status === 'EXPIRED' || status === 'ERROR' || status === 'UNKNOWN';
}

export function SettingsDashboard() {
  const {
    selectedInstrument,
    setSelectedInstrument,
    selectedTimeframe,
    setSelectedTimeframe,
    autoRefreshInterval,
    setAutoRefreshInterval,
    apiBaseUrl,
    setApiBaseUrl,
  } = useAppStore();

  const [fyersHealth, setFyersHealth] = useState<FyersHealthResponse | null>(null);
  const [fyersError, setFyersError] = useState<string | null>(null);
  const [fyersBanner, setFyersBanner] = useState<string | null>(null);
  const [fyersBusy, setFyersBusy] = useState(false);
  // Held separately from `fyersBusy` because it is terminal: the component is on its way out, so
  // the overlay must not be clearable by anything that finishes after it.
  const [fyersRedirecting, setFyersRedirecting] = useState(false);
  const router = useRouter();

  async function loadFyersHealth(): Promise<void> {
    try {
      const response = await fetch(`${getApiV1Url()}/health/fyers`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = await response.json() as FyersHealthResponse;
      setFyersHealth(payload);
      setFyersError(null);
    } catch (error) {
      setFyersHealth(null);
      setFyersError(error instanceof Error ? error.message : 'Fyers health unavailable.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`${getApiV1Url()}/health/fyers`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        const payload = await response.json() as FyersHealthResponse;
        if (!cancelled) {
          setFyersHealth(payload);
          setFyersError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setFyersHealth(null);
          setFyersError(error instanceof Error ? error.message : 'Fyers health unavailable.');
        }
      }
    }
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const fyers = params.get('fyers');
    const message = params.get('fyersMessage');

    // Strip the callback params first, synchronously, so a refresh cannot replay the banner.
    if (fyers) {
      params.delete('fyers');
      params.delete('fyersMessage');
      const next = params.toString();
      const path = `${window.location.pathname}${next ? `?${next}` : ''}`;
      window.history.replaceState({}, '', path);
    }

    // The banner reflects a one-shot OAuth redirect param read once on mount, not reactive state
    // derived from props/state, so `set-state-in-effect` is a false positive here: the URL is
    // stripped above, so this cannot re-run and cascade. Disabled with that justification rather
    // than deferred, because the rule tracks the set transitively through a microtask wrapper too.
    if (fyers === 'connected') {
      // A successful connect hands the user back to a settings page they only opened in order to
      // fix the connection, so it takes them onward to the dashboard.
      //
      // The navigation deliberately does not wait on a health refresh. It used to, so the
      // dashboard would land on fresh status rather than the stale pre-connect value — but
      // `/health/fyers` can take as long as any other Fyers-backed call, and this very page has
      // measured a 91-second hang on a lapsed credential. That turned a redirect into a
      // minute-and-a-half stare at a "connected" overlay. The dashboard fetches its own health on
      // mount, so blocking here bought nothing and risked everything.
      //
      // `replace`, not `push`: Back should return to wherever they started, not to a settings
      // page mid-redirect that would immediately bounce them forward again.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot OAuth redirect handover
      setFyersRedirecting(true);
      router.replace('/dashboard');
    } else if (fyers === 'error') {
      setFyersBanner(message || 'Fyers connect failed. Try again.');
      // The page may be retained across a client-side callback navigation. Refresh now
      // instead of leaving the previous green status visible until the 60-second poll.
      void loadFyersHealth();
    }
    // `router` is referentially stable across renders in the app router, so listing it satisfies
    // the dependency rule without making this one-shot effect run more than once — the URL params
    // it reads are stripped above, so a second run would find nothing anyway.
  }, [router]);

  async function connectFyers(): Promise<void> {
    setFyersBusy(true);
    setFyersBanner(null);
    try {
      const returnTo = `${window.location.origin}/settings`;
      const response = await fetch(
        `${getApiV1Url()}/fyers/auth/start?returnTo=${encodeURIComponent(returnTo)}`,
        { headers: { Accept: 'application/json' }, cache: 'no-store' },
      );
      const payload = await response.json() as { authorizeUrl?: string; error?: string; detail?: string };
      if (!response.ok || !payload.authorizeUrl) {
        setFyersBanner(payload.detail || payload.error || 'Could not start Fyers connect.');
        return;
      }
      window.location.assign(payload.authorizeUrl);
    } catch (error) {
      setFyersBanner(error instanceof Error ? error.message : 'Could not start Fyers connect.');
    } finally {
      setFyersBusy(false);
    }
  }

  async function disconnectFyers(): Promise<void> {
    if (!window.confirm('Disconnect Fyers? Option collection and Fyers candles will stop until you reconnect.')) {
      return;
    }
    setFyersBusy(true);
    setFyersBanner(null);
    try {
      const response = await fetch(`${getApiV1Url()}/fyers/auth/disconnect`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json() as { status?: string; error?: string };
      if (!response.ok) {
        setFyersBanner(payload.error || 'Disconnect failed.');
        return;
      }
      setFyersBanner('Fyers disconnected.');
      await loadFyersHealth();
    } catch (error) {
      setFyersBanner(error instanceof Error ? error.message : 'Disconnect failed.');
    } finally {
      setFyersBusy(false);
    }
  }

  const fyersStatus = fyersHealth?.status ?? 'UNKNOWN';
  const showConnect = needsReconnect(fyersStatus) || fyersStatus === 'EXPIRING_SOON';
  const showDisconnect = fyersStatus === 'OK' || fyersStatus === 'EXPIRING_SOON';

  // Returned before the page so the settings form is never briefly interactive underneath a
  // navigation that is already committed.
  if (fyersRedirecting) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <MarketLoader
          label="Fyers connected"
          sublabel="Tokens are stored on the API, never in this browser. Taking you to the dashboard…"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full space-y-6 p-6">
      <PageHeader
        eyebrow="Application Configuration"
        title="Settings"
        description="Configure your AI Quant Lab preferences and system settings."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
        <GlassPanel className="p-6 flex flex-col gap-6">
          <div>
            <h3 className="text-lg font-medium text-slate-200 mb-1">Trading Preferences</h3>
            <p className="text-sm text-slate-400 mb-4">Set your default viewing options for charts and data.</p>
            
            <div className="space-y-4">
              <Select
                label="Default Instrument"
                value={selectedInstrument || 'NIFTY50'}
                onChange={setSelectedInstrument}
                options={INSTRUMENT_OPTIONS}
              />

              <Select
                label="Default Timeframe"
                value={selectedTimeframe || '1m'}
                onChange={setSelectedTimeframe}
                options={TIMEFRAME_OPTIONS}
              />
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="p-6 flex flex-col gap-6">
          <div>
            <h3 className="text-lg font-medium text-slate-200 mb-1">System Settings</h3>
            <p className="text-sm text-slate-400 mb-4">Configure application behavior and connectivity.</p>
            
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-slate-400">Auto-refresh Interval (seconds)</label>
                <input
                  type="number"
                  value={autoRefreshInterval}
                  onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
                  className="bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
                  min={1}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-slate-400">API Base URL</label>
                <input
                  type="url"
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  className="bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
                  placeholder="http://localhost:4000/api/v1"
                />
              </div>

              <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="p-6 flex flex-col gap-4 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-medium text-slate-200 mb-1">Fyers broker login</h3>
              <p className="text-sm text-slate-400">
                Connect in the browser. Tokens stay on the API — never in this page.
              </p>
            </div>
            <span className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${statusBadgeClass(fyersStatus)}`}>
              {fyersStatus}
            </span>
          </div>

          {fyersBanner && (
            <p className={`text-sm ${fyersBanner.toLowerCase().includes('fail') || fyersBanner.toLowerCase().includes('error') || fyersBanner.toLowerCase().includes('invalid') ? 'text-rose-400' : 'text-emerald-300'}`}>
              {fyersBanner}
            </p>
          )}

          {fyersError && (
            <p className="text-sm text-rose-400">{fyersError}</p>
          )}

          {!fyersError && fyersHealth && (
            <div className="space-y-2 text-sm text-slate-300">
              {fyersHealth.accessTokenExpiresAt && (
                <p className="font-mono text-xs text-slate-400">
                  Access token expires: {fyersHealth.accessTokenExpiresAt}
                </p>
              )}
              {Array.isArray(fyersHealth.reasons) && fyersHealth.reasons.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-slate-400">
                  {fyersHealth.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {fyersHealth.lastError && (
                <p className="text-xs text-amber-300/90">Last error: {fyersHealth.lastError}</p>
              )}
              {(needsReconnect(fyersStatus) || fyersStatus === 'EXPIRING_SOON') && (
                <p className="text-xs text-slate-500">
                  {fyersHealth.recoveryHint ?? 'Connect Fyers below to refresh the session.'}
                </p>
              )}
            </div>
          )}

          {/* The wait between clicking connect and Fyers taking over the tab is a real one --
              the API has to be asked for an authorize URL first -- so it gets the loader rather
              than a disabled button that looks like nothing happened. */}
          {fyersBusy && (
            <MarketLoader
              className="py-4"
              label="Opening the Fyers session"
              size="sm"
              sublabel="You will be handed to Fyers to authorise this app"
            />
          )}

          <div className="flex flex-wrap gap-3 pt-1">
            {showConnect && (
              <button
                type="button"
                disabled={fyersBusy}
                onClick={() => { void connectFyers(); }}
                className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-50"
              >
                {fyersBusy ? 'Starting…' : 'Connect Fyers'}
              </button>
            )}
            {showDisconnect && (
              <button
                type="button"
                disabled={fyersBusy}
                onClick={() => { void disconnectFyers(); }}
                className="rounded-lg border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
          </div>
        </GlassPanel>
      </div>

      <div className="flex justify-end max-w-4xl">
        <p className="text-xs text-slate-500">Changes are saved automatically in this browser.</p>
      </div>
    </div>
  );
}
