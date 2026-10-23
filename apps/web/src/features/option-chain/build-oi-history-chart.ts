/**
 * Pure chart-series builder for the OI-over-time view. No React.
 *
 * Input is the `/option-chain/oi-history` payload, which has already done the data-shape work
 * (pre-open carryover separated, fixed strike set for totals, gaps detected). This module only turns it
 * into plot rows and keeps three promises the chart must not break:
 *
 * - **A gap is a gap.** A collection gap gets a null-valued break row inside it, so a line is cut there
 *   instead of drawing a straight segment across snapshots that were never taken -- which would be
 *   interpolation presented as data.
 * - **Null is not zero.** A contract outside the sliding strike window, or an unreported OI, plots as a
 *   gap. Only a reported 0 is a zero.
 * - **Two different changes, named differently.** "vs previous close" is the exchange's day-over-day
 *   baseline; "vs previous snapshot" is the move since the last collection. The first is not an
 *   intraday quantity and must never be labelled as one.
 */

export type OptionSide = "CE" | "PE";

export interface OiHistoryObservation {
  observedAt: string;
  kind: "PRE_OPEN_CARRYOVER" | "INTRADAY";
  underlyingValue: number | null;
  contractsObserved: number;
}

export interface OiHistoryPoint {
  present: boolean;
  openInterest: number | null;
  changeVsPreviousClose: number | null;
  changeVsPreviousSnapshot: number | null;
}

export interface OiHistoryContractSeries {
  strikePrice: number;
  optionType: OptionSide;
  previousCloseOpenInterest: number | null;
  baselineConsistent: boolean;
  points: OiHistoryPoint[];
}

export interface OiHistoryTotalsPoint {
  calls: number;
  puts: number;
  putCallRatio: number | null;
  callsChangeVsPreviousClose: number;
  putsChangeVsPreviousClose: number;
}

export interface OiHistoryTotals {
  rule: string;
  strikesUsed: number[];
  strikesExcluded: number;
  previousCloseCalls: number;
  previousClosePuts: number;
  points: OiHistoryTotalsPoint[];
}

export interface OiCollectionGap {
  from: string;
  to: string;
  minutes: number;
}

export interface OiHistorySessionSummary {
  sessionDate: string;
  snapshotCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface OiHistoryAvailable {
  available: true;
  underlyingSymbol: string;
  sessionDate: string;
  sessionTimezone: string;
  expiryDate: string | null;
  oiUnit: string;
  contractSelection: "REQUESTED" | "DEFAULT";
  availableSessions: OiHistorySessionSummary[];
  preOpen: OiHistoryObservation | null;
  observations: OiHistoryObservation[];
  collectionGaps: OiCollectionGap[];
  contracts: OiHistoryContractSeries[];
  totals: OiHistoryTotals | { unavailable: string } | null;
  selectableStrikes: number[];
}

export interface OiHistoryUnavailable {
  available: false;
  reason: string;
  underlyingSymbol?: string;
  sessionDate?: string;
  expiryDate?: string | null;
  availableSessions?: OiHistorySessionSummary[];
}

export type OiHistoryPayload = OiHistoryAvailable | OiHistoryUnavailable;

export type OiHistoryMode = "totals" | "contracts";
export type OiHistoryMetric = "level" | "changeVsPreviousClose" | "changeVsPreviousSnapshot";

export interface OiHistorySeriesDef {
  key: string;
  label: string;
  side: "call" | "put";
  color: string;
}

export interface OiHistoryChartRow {
  /** Epoch milliseconds, the numeric time axis. */
  t: number;
  /** Spot as stored with the snapshot, not a live price. Null on a gap break row. */
  underlying: number | null;
  /** Totals mode only: puts / calls at this snapshot. */
  putCallRatio: number | null;
  /** True for the synthetic row that cuts lines inside a collection gap. */
  isGapBreak: boolean;
  values: Record<string, number | null>;
}

export interface OiHistoryBaseline {
  label: string;
  value: number;
  color: string;
}

export interface OiHistoryChartModel {
  rows: OiHistoryChartRow[];
  series: OiHistorySeriesDef[];
  gapAreas: Array<{ x1: number; x2: number; minutes: number }>;
  baselines: OiHistoryBaseline[];
  yAxisLabel: string;
  /** Change metrics are signed around zero, so the chart draws a zero line. */
  signed: boolean;
  /** Largest absolute value plotted (series and baselines): what an axis picks its single unit from. */
  maxAbs: number;
  /** Why there is nothing to plot, when that is the case. */
  emptyReason: string | null;
}

const CALL_COLOR = "#34d399";
const PUT_COLOR = "#f472b6";

/** Distinguishable hues for per-contract lines. Side is carried by line style and marker, not hue alone. */
export const CONTRACT_PALETTE: readonly string[] = [
  "#34d399", "#f472b6", "#60a5fa", "#fbbf24", "#a78bfa", "#fb923c", "#2dd4bf", "#e879f9",
];

const UNIT = "units (Fyers oi; not lots)";

export const METRIC_LABELS: Record<OiHistoryMetric, string> = {
  level: "OI level",
  changeVsPreviousClose: "Δ vs prev. close",
  changeVsPreviousSnapshot: "Δ vs previous snapshot",
};

function yAxisLabelFor(metric: OiHistoryMetric): string {
  if (metric === "level") return `OI, ${UNIT}`;
  if (metric === "changeVsPreviousClose") return `Δ OI vs prev. close, ${UNIT}`;
  return `Δ OI vs previous snapshot, ${UNIT}`;
}

export function contractKey(strikePrice: number, optionType: OptionSide): string {
  return `${strikePrice}${optionType}`;
}

function totalsValue(
  points: readonly OiHistoryTotalsPoint[],
  index: number,
  side: "calls" | "puts",
  metric: OiHistoryMetric,
): number | null {
  const point = points[index]!;
  if (metric === "level") return point[side];
  if (metric === "changeVsPreviousClose") {
    return side === "calls" ? point.callsChangeVsPreviousClose : point.putsChangeVsPreviousClose;
  }
  // Totals are over a fixed strike set, so a snapshot-to-snapshot difference is a real change.
  if (index === 0) return null;
  return point[side] - points[index - 1]![side];
}

function contractValue(point: OiHistoryPoint, metric: OiHistoryMetric): number | null {
  if (metric === "level") return point.openInterest;
  if (metric === "changeVsPreviousClose") return point.changeVsPreviousClose;
  return point.changeVsPreviousSnapshot;
}

/** Inserts a null row in the middle of each collection gap and returns the shaded spans. */
function withGapBreaks(
  rows: OiHistoryChartRow[],
  gaps: readonly OiCollectionGap[],
  seriesKeys: readonly string[],
): { rows: OiHistoryChartRow[]; gapAreas: OiHistoryChartModel["gapAreas"] } {
  const gapAreas: OiHistoryChartModel["gapAreas"] = [];
  const out = [...rows];
  for (const gap of gaps) {
    const from = Date.parse(gap.from);
    const to = Date.parse(gap.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    gapAreas.push({ x1: from, x2: to, minutes: gap.minutes });
    out.push({
      t: Math.round((from + to) / 2),
      underlying: null,
      putCallRatio: null,
      isGapBreak: true,
      values: Object.fromEntries(seriesKeys.map((key) => [key, null])),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return { rows: out, gapAreas };
}

export function buildOiHistoryChart(
  payload: OiHistoryAvailable,
  options: { mode: OiHistoryMode; metric: OiHistoryMetric },
): OiHistoryChartModel {
  const { mode, metric } = options;
  const observations = payload.observations;
  const signed = metric !== "level";
  const empty = (reason: string): OiHistoryChartModel => ({
    rows: [],
    series: [],
    gapAreas: [],
    baselines: [],
    yAxisLabel: yAxisLabelFor(metric),
    signed,
    maxAbs: 0,
    emptyReason: reason,
  });

  if (observations.length === 0) {
    return empty("No intraday snapshot in this session yet. The pre-open snapshot repeats the previous close and is not plotted.");
  }

  const times = observations.map((o) => Date.parse(o.observedAt));
  let series: OiHistorySeriesDef[];
  let baseRows: OiHistoryChartRow[];
  let baselines: OiHistoryBaseline[] = [];

  if (mode === "totals") {
    const totals = payload.totals;
    if (totals === null || "unavailable" in totals) {
      return empty(totals === null ? "Totals are unavailable for this session." : totals.unavailable);
    }
    series = [
      { key: "calls", label: "Calls total", side: "call", color: CALL_COLOR },
      { key: "puts", label: "Puts total", side: "put", color: PUT_COLOR },
    ];
    baseRows = observations.map((observation, i) => ({
      t: times[i]!,
      underlying: observation.underlyingValue,
      putCallRatio: totals.points[i]!.putCallRatio,
      isGapBreak: false,
      values: {
        calls: totalsValue(totals.points, i, "calls", metric),
        puts: totalsValue(totals.points, i, "puts", metric),
      },
    }));
    if (metric === "level") {
      baselines = [
        { label: "calls prev. close", value: totals.previousCloseCalls, color: CALL_COLOR },
        { label: "puts prev. close", value: totals.previousClosePuts, color: PUT_COLOR },
      ];
    }
  } else {
    if (payload.contracts.length === 0) return empty("No contracts selected.");
    series = payload.contracts.map((contract, index) => ({
      key: contractKey(contract.strikePrice, contract.optionType),
      label: `${contract.strikePrice} ${contract.optionType}`,
      side: contract.optionType === "CE" ? "call" : "put",
      color: CONTRACT_PALETTE[index % CONTRACT_PALETTE.length]!,
    }));
    baseRows = observations.map((observation, i) => ({
      t: times[i]!,
      underlying: observation.underlyingValue,
      putCallRatio: null,
      isGapBreak: false,
      values: Object.fromEntries(
        payload.contracts.map((contract) => {
          // Series are aligned to observations by the API; a short array reads as "no data", not a crash.
          const point = contract.points[i];
          return [
            contractKey(contract.strikePrice, contract.optionType),
            point ? contractValue(point, metric) : null,
          ];
        }),
      ),
    }));
  }

  const { rows, gapAreas } = withGapBreaks(baseRows, payload.collectionGaps, series.map((s) => s.key));

  let maxAbs = 0;
  for (const row of rows) {
    for (const value of Object.values(row.values)) {
      if (value !== null && Number.isFinite(value)) maxAbs = Math.max(maxAbs, Math.abs(value));
    }
  }
  for (const baseline of baselines) maxAbs = Math.max(maxAbs, Math.abs(baseline.value));

  return {
    rows,
    series,
    gapAreas,
    baselines,
    yAxisLabel: yAxisLabelFor(metric),
    signed,
    maxAbs,
    emptyReason: null,
  };
}

export interface ContractToken {
  strikePrice: number;
  optionType: OptionSide;
}

/**
 * The query string for `/option-chain/oi-history`. `contracts: null` omits the parameter so the server
 * chooses its default selection; an empty list is never sent, because omitting it would silently bring
 * the defaults back.
 */
export function oiHistoryQuery(input: {
  underlying: string;
  expiry: string;
  sessionDate: string;
  contracts: readonly ContractToken[] | null;
}): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.expiry) params.set("expiry", input.expiry);
  if (input.sessionDate) params.set("date", input.sessionDate);
  if (input.contracts !== null && input.contracts.length > 0) {
    params.set("contracts", input.contracts.map((c) => contractKey(c.strikePrice, c.optionType)).join(","));
  }
  return params.toString();
}
