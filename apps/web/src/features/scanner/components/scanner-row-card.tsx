import { GlassPanel, InteractiveGlassCard } from "../../../components/ui/glass-panel";
import { formatNumber, formatPercentage, formatTimestamp, labelTone, scalarSummary } from "../../research/presentation";
import type {
  ScannerIndicator,
  ScannerPriceActionEvent,
  ScannerRow,
} from "../domain";

function IndicatorList({ indicators }: { indicators: ScannerIndicator[] }) {
  if (indicators.length === 0) {
    return <p className="text-sm text-slate-400">No persisted indicator snapshots for this completed candle.</p>;
  }
  return (
    <ul className="space-y-3">
      {indicators.map((indicator) => (
        <li className="rounded-xl border border-white/10 bg-slate-950/35 p-3" key={`${indicator.code}-${indicator.algorithmVersion}`}>
          <p className="text-sm font-medium text-slate-200">{indicator.code} <span className="font-normal text-slate-500">{indicator.algorithmVersion}</span></p>
          <p className="mt-1 text-xs leading-5 text-slate-400">{scalarSummary(indicator.values) ?? "No scalar values were recorded."}</p>
          {scalarSummary(indicator.parameters, 2) ? <p className="mt-1 text-xs leading-5 text-slate-500">Parameters: {scalarSummary(indicator.parameters, 2)}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ContextBadge({
  label,
  direction,
  description,
}: {
  label: string;
  direction: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-200">{label}</p>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${labelTone(direction)}`}>{direction}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

function PriceActionContext({ event }: { event: ScannerPriceActionEvent }) {
  return (
    <ContextBadge
      description={`${event.algorithmVersion} - level ${formatNumber(event.level)} - confidence ${formatPercentage(event.confidence)}`}
      direction={event.direction}
      label={event.eventType}
    />
  );
}

export function ScannerRowCard({ record }: { record: ScannerRow }) {
  const candle = record.latestCompletedCandle;
  const model = record.modelPrediction;
  return (
    <InteractiveGlassCard className="p-5">
      <article>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100">Completed-candle context</p>
            <h3 className="mt-2 text-xl font-semibold text-slate-100">{record.instrument.symbol} <span className="font-normal text-slate-400">- {candle.timeframe}</span></h3>
            <p className="mt-1 text-sm text-slate-400">{record.instrument.displayName} - {record.instrument.exchange} - closed {formatTimestamp(candle.closeTime)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Recorded close</p>
            <p className="mt-1 text-lg font-semibold text-slate-100">{formatNumber(candle.close)}</p>
            <p className="mt-1 text-xs text-slate-500">Completed evidence, not a current quote.</p>
          </div>
        </div>

        <dl className="mt-5 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-slate-950/40 p-3"><dt className="text-xs text-slate-500">Open</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatNumber(candle.open)}</dd></div>
          <div className="rounded-xl bg-slate-950/40 p-3"><dt className="text-xs text-slate-500">High / low</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatNumber(candle.high)} / {formatNumber(candle.low)}</dd></div>
          <div className="rounded-xl bg-slate-950/40 p-3"><dt className="text-xs text-slate-500">Volume</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatNumber(candle.volume, 2)}</dd></div>
          <div className="rounded-xl bg-slate-950/40 p-3"><dt className="text-xs text-slate-500">Opened</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatTimestamp(candle.openTime)}</dd></div>
        </dl>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section>
            <h4 className="text-sm font-semibold text-slate-100">Persisted indicators</h4>
            <p className="mt-1 text-xs leading-5 text-slate-500">Values are the saved calculation context for this completed candle.</p>
            <div className="mt-3"><IndicatorList indicators={record.indicators} /></div>
          </section>
          <section>
            <h4 className="text-sm font-semibold text-slate-100">Recorded pattern and price-action context</h4>
            <p className="mt-1 text-xs leading-5 text-slate-500">These labels describe stored research evidence; they do not authorize a trade.</p>
            <div className="mt-3 space-y-3">
              {record.patterns.length === 0 && record.priceActionEvents.length === 0 ? <p className="text-sm text-slate-400">No persisted pattern or price-action events for this completed candle.</p> : null}
              {record.patterns.map((pattern) => (
                <ContextBadge
                  description={`${pattern.algorithmVersion} - confidence ${formatPercentage(pattern.confidence)}`}
                  direction={pattern.direction}
                  key={`${pattern.code}-${pattern.algorithmVersion}`}
                  label={pattern.code}
                />
              ))}
              {record.priceActionEvents.map((event) => <PriceActionContext event={event} key={`${event.eventType}-${event.algorithmVersion}`} />)}
            </div>
          </section>
        </div>

        <GlassPanel className="mt-5 border-white/10 bg-slate-950/35 p-4 shadow-none">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-slate-100">Stored model observation</h4>
              <p className="mt-1 text-xs leading-5 text-slate-500">When present, this is a previously persisted Phase 11 observation. It is not generated by opening this scanner.</p>
            </div>
            {model ? <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${labelTone(model.prediction)}`}>{model.prediction}</span> : null}
          </div>
          {model ? (
            <dl className="mt-4 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-xs text-slate-500">Confidence</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatPercentage(model.confidence)}</dd></div>
              <div><dt className="text-xs text-slate-500">Evidence cutoff</dt><dd className="mt-1 text-sm font-medium text-slate-200">{formatTimestamp(model.evidenceCutoffAt)}</dd></div>
              <div><dt className="text-xs text-slate-500">Model</dt><dd className="mt-1 text-sm font-medium text-slate-200">{model.model.key} v{model.model.version}</dd></div>
              <div><dt className="text-xs text-slate-500">Current stage</dt><dd className="mt-1 text-sm font-medium text-slate-200">{model.model.currentStage}</dd></div>
            </dl>
          ) : <p className="mt-4 text-sm text-slate-400">No stored model prediction is linked to this completed candle.</p>}
        </GlassPanel>
      </article>
    </InteractiveGlassCard>
  );
}
