"use client";

import React, { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildExposure,
  CONVENTION_TEXT,
  formatDeltaUnits,
  deltaUnitsAxisFormatter,
  formatFlipOffset,
  formatRupees,
  NET_NOISE_SHARE,
  rupeeAxisFormatter,
  symmetricTicks,
  type ExposureConvention,
  type ExposureResult,
  type ExposureStrikeInput,
} from "../build-exposure";
import { DEFAULT_STRIKE_WINDOW, nearestStrikeOnAxis } from "../strike-axis";
import { SnapshotFreshnessBar } from "./snapshot-freshness-bar";

const CALL_COLOR = "#34d399";
const PUT_COLOR = "#f472b6";
const NET_COLOR = "#a78bfa";
const AXIS_TICK = { fill: "rgba(148,163,184,0.9)", fontSize: 11 };

export interface ExposurePanelProps {
  strikes: readonly ExposureStrikeInput[];
  atmStrike: number | null;
  /** The index spot of the stored snapshot. */
  underlyingValue: number | null;
  /** The expiry's parity-implied forward from the same snapshot; spot stands in when absent. */
  forward: number | null;
  observedAt: string | null | undefined;
  provider?: string | null;
  expiryLabel?: string | null;
  nowMs: number;
}

interface BarRow {
  strike: number;
  /** Plotted upward. */
  call: number | null;
  /** Plotted downward (negated): a magnitude, so the mirror carries no sign meaning. */
  put: number | null;
  callValue: number | null;
  putValue: number | null;
}

function barRows(points: ExposureResult["points"], pick: (p: ExposureResult["points"][number]) => [number | null, number | null]): BarRow[] {
  return points.map((point) => {
    const [call, put] = pick(point);
    return { strike: point.strike, call, put: put === null ? null : -put, callValue: call, putValue: put };
  });
}

function BarTooltip({
  active,
  payload,
  format,
  callLabel,
  putLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: BarRow }>;
  format: (value: number | null) => string;
  callLabel: string;
  putLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="font-bold text-white">Strike {row.strike}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-emerald-300">{callLabel} ●</span><span>{format(row.callValue)}</span>
        <span className="text-fuchsia-300">{putLabel} ■</span><span>{format(row.putValue)}</span>
      </div>
    </div>
  );
}

/** Call bars up and put bars down, on one strike axis, with the ATM and spot strikes marked. */
function MirroredBars({
  rows,
  format,
  axisFormat,
  atmMark,
  spotMark,
  callLabel,
  putLabel,
  label,
}: {
  rows: BarRow[];
  format: (value: number | null) => string;
  /** Writes every tick of the axis in one unit. */
  axisFormat: (maxAbs: number) => (value: number) => string;
  atmMark: number | null;
  spotMark: number | null;
  callLabel: string;
  putLabel: string;
  label: string;
}) {
  const maxAbs = Math.max(0, ...rows.flatMap((row) => [Math.abs(row.call ?? 0), Math.abs(row.put ?? 0)]));
  const ticks = symmetricTicks(maxAbs);
  const top = ticks[ticks.length - 1]!;
  const tickText = axisFormat(top);
  return (
    <div className="h-[260px] w-full" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, left: 8, bottom: 8 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
          <XAxis dataKey="strike" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} interval="preserveStartEnd" />
          <YAxis ticks={ticks} tickFormatter={(value: number) => tickText(Math.abs(value))} tick={AXIS_TICK} tickLine={false} axisLine={false} width={64} domain={[-top, top]} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} content={<BarTooltip format={format} callLabel={callLabel} putLabel={putLabel} />} />
          <Legend formatter={(value: string) => <span className="text-xs text-slate-300">{value}</span>} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" />
          {atmMark !== null && <ReferenceLine x={atmMark} stroke="rgba(251,191,36,0.7)" strokeDasharray="4 3" label={{ value: "ATM", fill: "rgba(251,191,36,0.9)", fontSize: 10, position: "insideTopRight" }} />}
          {spotMark !== null && spotMark !== atmMark && <ReferenceLine x={spotMark} stroke="rgba(148,163,184,0.7)" strokeDasharray="2 4" label={{ value: "spot", fill: "rgba(148,163,184,0.9)", fontSize: 10, position: "insideTopLeft" }} />}
          <Bar dataKey="call" name={`${callLabel} (up, green)`} fill={CALL_COLOR} isAnimationActive={false} />
          <Bar dataKey="put" name={`${putLabel} (down, pink)`} fill={PUT_COLOR} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="font-mono text-sm text-slate-100">{value}</p>
    </div>
  );
}

function excludedSentence(result: ExposureResult): string | null {
  const { call, put } = result.totals.excluded;
  const total = (side: typeof call) => side.noOpenInterest + side.noImpliedVolatility + side.noExpiry;
  if (total(call) + total(put) === 0) return null;
  const part = (name: string, side: typeof call) => {
    const bits = [
      side.noOpenInterest > 0 ? `${side.noOpenInterest} without OI` : null,
      side.noImpliedVolatility > 0 ? `${side.noImpliedVolatility} with no solved IV` : null,
      side.noExpiry > 0 ? `${side.noExpiry} with no time to expiry` : null,
    ].filter(Boolean);
    return bits.length > 0 ? `${name}: ${bits.join(", ")}` : null;
  };
  return `Left out of every total (never counted as zero) — ${[part("calls", call), part("puts", put)].filter(Boolean).join("; ")}.`;
}

/**
 * Gamma and theta exposure of the open interest on one expiry, from the stored snapshot.
 *
 * Three kinds of number, kept apart on the screen: gamma-weighted OI and the time decay of OI (observed OI x model Greeks,
 * no assumption about who holds what); and a net gamma exposure, which needs a stated assumption about positioning that
 * open interest does not carry and is therefore chosen by the reader, labelled as an assumption, and flips with the choice.
 */
export function ExposurePanel({ strikes, atmStrike, underlyingValue, forward, observedAt, provider, expiryLabel, nowMs }: ExposurePanelProps) {
  const [convention, setConvention] = useState<ExposureConvention>("calls-long");

  const result = useMemo(
    () => (underlyingValue !== null && underlyingValue > 0 && strikes.length > 0
      ? buildExposure(strikes, { spot: underlyingValue, forward, atmStrike, window: DEFAULT_STRIKE_WINDOW, convention })
      : null),
    [strikes, underlyingValue, forward, atmStrike, convention],
  );

  const axisStrikes = result?.points.map((p) => p.strike) ?? [];
  const atmMark = nearestStrikeOnAxis(axisStrikes, atmStrike);
  const spotMark = nearestStrikeOnAxis(axisStrikes, underlyingValue);
  const gammaRows = useMemo(() => (result ? barRows(result.points, (p) => [p.callGammaOi, p.putGammaOi]) : []), [result]);
  const decayRows = useMemo(() => (result ? barRows(result.points, (p) => [p.callDecay, p.putDecay]) : []), [result]);

  if (result === null) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-950/40 p-6 text-sm text-slate-400">
        {underlyingValue === null || underlyingValue <= 0
          ? "This snapshot has no underlying value, so exposure cannot be computed."
          : "No strikes in this snapshot to compute exposure from."}
      </div>
    );
  }

  const { totals } = result;
  const excluded = excludedSentence(result);
  const flip = result.flips[0] ?? null;
  // The sweep carries the call and put lines too, so the axis covers all three, symmetric about zero like the bar charts.
  const sweepTop = Math.max(...result.sweep.flatMap((p) => [Math.abs(p.callGex), Math.abs(p.putGex), Math.abs(p.netGex)]));
  const sweepTicks = symmetricTicks(sweepTop);

  return (
    <div className="w-full">
      <SnapshotFreshnessBar observedAt={observedAt} provider={provider} expiryLabel={expiryLabel} nowMs={nowMs} />

      <div className="mb-3 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-400">
        <p><span className="font-bold text-slate-200">What this is. </span>
          Open interest times Black–Scholes gamma and theta at each leg&apos;s solved IV, for this expiry only. It describes what <em>all</em> of the open interest would do if held long. Open interest does not say who is long and who is short, so any net figure below rests on an assumption you choose, not on data.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label="Call gamma-OI" value={`${formatDeltaUnits(totals.callGammaOi)} Δ/pt`} hint="Gamma x OI, summed over calls: change in total delta, in underlying units, per index point." />
        <Stat label="Put gamma-OI" value={`${formatDeltaUnits(totals.putGammaOi)} Δ/pt`} />
        <Stat label="Call decay" value={`${formatRupees(totals.callDecay)}/day`} hint="Premium the call OI loses per calendar day if held long." />
        <Stat label="Put decay" value={`${formatRupees(totals.putDecay)}/day`} />
      </div>
      <p className="mb-4 text-[11px] text-slate-500">
        {totals.strikesInChain} strikes in this snapshot ({totals.lowestStrike}–{totals.highestStrike}); open interest on strikes outside that stored window is not included, so each total is a lower bound.
        {excluded ? ` ${excluded}` : ""}
        {!result.forwardFromChain ? " No parity-implied forward was stored, so the spot stands in for it." : ""}
      </p>

      <h4 className="text-xs font-bold text-slate-200">Gamma-weighted open interest by strike</h4>
      <p className="mb-1 text-[11px] text-slate-500">Observed OI x model gamma, delta-units per index point. Calls up, puts down (a magnitude: the mirror carries no meaning).</p>
      <MirroredBars rows={gammaRows} format={formatDeltaUnits} axisFormat={deltaUnitsAxisFormatter} atmMark={atmMark} spotMark={spotMark} callLabel="Call gamma-OI" putLabel="Put gamma-OI" label="Gamma-weighted open interest by strike" />

      <h4 className="mt-5 text-xs font-bold text-slate-200">Time decay of open interest by strike</h4>
      <p className="mb-1 text-[11px] text-slate-500">Rupees of premium lost per calendar day if the OI were held long: −theta x OI. Calls up, puts down (a magnitude). A deep in-the-money contract can have positive theta, which would plot as a negative decay.</p>
      <MirroredBars rows={decayRows} format={formatRupees} axisFormat={rupeeAxisFormatter} atmMark={atmMark} spotMark={spotMark} callLabel="Call decay" putLabel="Put decay" label="Daily time decay of open interest by strike" />

      <div className="mt-6 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3">
        <h4 className="text-xs font-bold text-amber-100">Net gamma exposure — rests on an assumption</h4>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 text-slate-300">
            Assume
            <select
              value={convention}
              onChange={(event) => setConvention(event.target.value as ExposureConvention)}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
            >
              <option value="calls-long">calls held long, puts held short</option>
              <option value="puts-long">puts held long, calls held short</option>
            </select>
          </label>
          <span className="text-amber-100/90">{CONVENTION_TEXT[convention]} Neither is observed.</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat label="Call exposure" value={`${formatRupees(totals.callGex)} per 1%`} hint="Rupees of delta-notional that move per 1% move in the index, from the calls' OI." />
          <Stat label="Put exposure" value={`${formatRupees(totals.putGex)} per 1%`} />
          <Stat label="Net, as assumed" value={`${formatRupees(totals.netGex)} per 1%`} hint="Call minus put, signed by the assumption above." />
          <Stat
            label="Sign change (model)"
            value={flip ? `${Math.round(flip.spot).toLocaleString("en-IN")} (${formatFlipOffset(flip.percent)})` : "none within ±4%"}
            hint="Where the net changes sign when the whole chain is re-priced at other spots, each leg keeping its solved IV."
          />
        </div>
        {totals.netShareOfGross !== null && (
          <p className={`mt-2 text-[11px] ${totals.netShareOfGross < NET_NOISE_SHARE ? "text-amber-200" : "text-slate-400"}`}>
            The net is {(totals.netShareOfGross * 100).toFixed(1)}% of the gross (call + put) exposure.
            {totals.netShareOfGross < NET_NOISE_SHARE
              ? " That is a small difference between two large, similar numbers: its sign at the current spot is within the noise of the model (IV solved from mid quotes, OI only on the stored strikes), and so is whether the market is \"above\" or \"below\" the sign change. Read the shape of the curve, not the sign."
              : ""}
          </p>
        )}
        {result.flips.length > 1 && (
          <p className="mt-2 text-[11px] text-slate-400">
            Other sign changes: {result.flips.slice(1).map((f) => `${Math.round(f.spot).toLocaleString("en-IN")} (${formatFlipOffset(f.percent)})`).join(", ")}.
          </p>
        )}

        <div className="mt-3 h-[260px] w-full" role="img" aria-label="Net gamma exposure at hypothetical spot prices, under the chosen assumption">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={result.sweep} margin={{ top: 8, right: 12, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="spot" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(value: number) => Math.round(value).toLocaleString("en-IN")} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} />
              <YAxis ticks={sweepTicks} tickFormatter={rupeeAxisFormatter(sweepTicks[sweepTicks.length - 1]!)} tick={AXIS_TICK} tickLine={false} axisLine={false} width={64} domain={[sweepTicks[0]!, sweepTicks[sweepTicks.length - 1]!]} />
              <Tooltip
                cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                formatter={(value, name) => [formatRupees(typeof value === "number" ? value : null), String(name)]}
                labelFormatter={(label) => `Spot ${Math.round(Number(label)).toLocaleString("en-IN")}`}
                contentStyle={{ background: "rgba(2,6,23,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
              />
              <Legend formatter={(value: string) => <span className="text-xs text-slate-300">{value}</span>} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" />
              <ReferenceLine x={result.spot} stroke="rgba(148,163,184,0.8)" strokeDasharray="2 4" label={{ value: "spot", fill: "rgba(148,163,184,0.9)", fontSize: 10, position: "insideTopLeft" }} />
              {result.flips.map((f) => (
                <ReferenceLine key={f.spot} x={f.spot} stroke="rgba(251,191,36,0.8)" strokeDasharray="4 3" label={{ value: "sign change", fill: "rgba(251,191,36,0.9)", fontSize: 10, position: "insideTopRight" }} />
              ))}
              <Line type="linear" dataKey="callGex" name="Call exposure (thin)" stroke={CALL_COLOR} strokeWidth={1} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="putGex" name="Put exposure (thin, dotted)" stroke={PUT_COLOR} strokeWidth={1} strokeDasharray="1 3" dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="netGex" name="Net, as assumed (thick)" stroke={NET_COLOR} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Re-priced at each spot from −4% to +4% with the forward moved in proportion and every leg keeping the IV solved at the snapshot. Real markets move IV with spot, which this does not, so the position of a sign change is a model result, the most assumption-dependent number here. The call and put lines are the observed exposures and do not depend on the assumption; only their sign in the net does.
        </p>
      </div>

      {result.vendor && (
        <p className="mt-4 text-[11px] text-slate-500">
          Cross-check with Fyers&apos; own gamma over {result.vendor.strikesCompared} strikes: gamma x OI on the calls is {formatDeltaUnits(result.vendor.vendorGammaOi)} Δ/pt with Fyers&apos; value against {formatDeltaUnits(result.vendor.modelGammaOi)} with ours
          {result.vendor.ratio !== null ? ` (Fyers ${(result.vendor.ratio * 100).toFixed(0)}% of ours)` : ""}. Fyers reports gamma to four decimals, which is coarse for out-of-the-money strikes, so single strikes can differ a lot while the total agrees better.
        </p>
      )}
      <details className="mt-3 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">Definitions and units</summary>
        <ul className="mt-2 space-y-1">
          <li><span className="font-bold text-slate-300">Gamma-OI</span>: gamma x open interest. Open interest is in underlying units, as Fyers reports it (not lots), so this is the change in the OI&apos;s total delta, in underlying units, per 1 index point.</li>
          <li><span className="font-bold text-slate-300">Exposure per 1%</span>: gamma-OI x spot² x 0.01. Rupees of delta-notional that move for a 1% move in the index.</li>
          <li><span className="font-bold text-slate-300">Decay</span>: −theta x OI, rupees of premium per calendar day, if held long.</li>
          <li>Gamma and theta are Black–Scholes at each leg&apos;s IV solved from the mid, priced off the snapshot&apos;s parity-implied forward, and unrounded. They are model values, not exchange data.</li>
          <li>Totals cover the strikes in the stored snapshot, which slides with the at-the-money strike; one expiry only, so near-expiry and far-expiry exposure are not combined.</li>
        </ul>
      </details>
      <p className="mt-2 text-[11px] text-slate-500">
        Observation, not a signal: neither a large exposure nor a sign change says price will move, stall or reverse. The net figure describes a model of positioning, not the positioning.
      </p>
    </div>
  );
}
