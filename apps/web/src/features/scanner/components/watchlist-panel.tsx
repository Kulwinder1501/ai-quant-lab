import { InteractiveGlassCard, GlassPanel } from "../../../components/ui/glass-panel";
import { Stagger } from "../../../components/ui/reveal";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { formatNumber } from "../../research/presentation";
import type { WatchlistInstrument } from "../domain";

interface WatchlistPanelProps {
  state: RequestState;
  instruments: WatchlistInstrument[];
}

export function WatchlistPanel({ state, instruments }: WatchlistPanelProps) {
  if (state !== "ready") {
    return (
      <RequestStatePanel
        emptyDescription="The watchlist is an active registry projection, not an editable favorites list. Active instruments will appear here after they have been registered locally."
        emptyTitle="No active local instruments yet"
        loadingDescription="The dashboard is issuing a GET-only request to the local API. It will not start a collector, fetch a provider, or initiate a research workflow while it waits."
        loadingTitle="Loading active local instruments..."
        state={state}
        unavailableDescription="The local API did not return a valid persisted response. This screen does not substitute current market data or infer an alternative result."
        unavailableTitle="Active local instruments are unavailable"
      />
    );
  }

  return (
    <GlassPanel className="overflow-hidden">
      <div className="border-b border-white/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">Registry projection</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-100">Active local instrument watchlist</h2>
        <p className="mt-1 text-sm leading-6 text-slate-400">A read-only view of active instrument registry entries. It is not an editable favorites or alert list.</p>
      </div>
      <div className="grid gap-px bg-white/10 sm:grid-cols-2">
        <Stagger className="bg-slate-950/35">
          {instruments.map((instrument) => (
            <InteractiveGlassCard className="h-full rounded-none border-0 bg-slate-950/35 p-5 shadow-none backdrop-blur-none hover:bg-slate-900/75" key={instrument.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-100">{instrument.symbol}</h3>
                  <p className="mt-1 text-sm text-slate-400">{instrument.displayName}</p>
                </div>
                <span className="rounded-full border border-cyan-200/30 bg-cyan-200/10 px-2.5 py-1 text-xs font-semibold text-cyan-50">{instrument.registryStatus}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-slate-500">Exchange</dt><dd className="mt-1 font-medium text-slate-200">{instrument.exchange}</dd></div>
                <div><dt className="text-slate-500">Type</dt><dd className="mt-1 font-medium text-slate-200">{instrument.instrumentType}</dd></div>
                <div><dt className="text-slate-500">Tick size</dt><dd className="mt-1 font-medium text-slate-200">{formatNumber(instrument.tickSize, 6)}</dd></div>
                <div><dt className="text-slate-500">Lot size</dt><dd className="mt-1 font-medium text-slate-200">{formatNumber(instrument.lotSize, 4)}</dd></div>
              </dl>
              <p className="mt-4 text-xs text-slate-500">{instrument.currency} - {instrument.timezone}</p>
            </InteractiveGlassCard>
          ))}
        </Stagger>
      </div>
    </GlassPanel>
  );
}
