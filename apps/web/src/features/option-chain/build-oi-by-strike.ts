/**
 * Pure OI-by-strike series builder for the option-chain chart.
 *
 * No React. Null open interest stays null so a missing quote never plots as zero.
 *
 * Units: Fyers `oi` is stored as underlying units (not lots/contracts). Over 30 days of
 * `option_chain_snapshots`, BANKNIFTY OI was a whole multiple of its lot (30) on 100% of rows and
 * NIFTY50 OI of 65 on 98.0%. The residue is explained, and none of it is a lot-size problem: 60% is
 * the 09:11 pre-open slot (it repeats the previous close), and of the intraday remainder (0.7% of
 * rows, 17 contracts) about half is the 10-20 holiday echoing the previous close and the rest is two
 * expiry-week September puts whose OI is off-lot early in a day and aligned later, while their
 * neighbours at the same instant were not. Do not divide OI by the lot to get lots; the unit is
 * underlying units. The registry once held 75 for NIFTY50 (corrected to the exchange's 65 by
 * migration 141). Axis label must say units. Do not claim "always" beyond the measured window.
 */

export const OI_AXIS_UNIT_LABEL = "units (Fyers oi; not lots)";

/** Vendor oich is vs previous session close, not vs the prior intraday snapshot. */
export const OI_CHANGE_BASELINE_LABEL = "Δ vs prev. close";

export interface OiStrikeLegInput {
  openInterest: number | null;
  openInterestChange: number | null;
}

export interface OiStrikeInput {
  strikePrice: number;
  call: OiStrikeLegInput | null;
  put: OiStrikeLegInput | null;
}

export type OiChangeSign = "up" | "down" | "flat" | "missing";

export interface OiByStrikePoint {
  strike: number;
  /** Absolute call OI in units, or null when the leg/value is absent. */
  callOi: number | null;
  putOi: number | null;
  callOiChange: number | null;
  putOiChange: number | null;
  callOiChangePct: number | null;
  putOiChangePct: number | null;
  callChangeSign: OiChangeSign;
  putChangeSign: OiChangeSign;
  /**
   * Plot values for a mirrored bar chart: call stays non-negative, put is negated.
   * Null when missing — never coerced to 0. Zero OI plots as 0 (not -0).
   */
  callOiPlot: number | null;
  putOiPlot: number | null;
}

export interface BuildOiByStrikeOptions {
  /** Inclusive half-width in strike count around the window centre. Omitted or null → all strikes. */
  window?: number | null;
  atmStrike?: number | null;
}

export interface BuildOiByStrikeResult {
  points: OiByStrikePoint[];
  unitLabel: string;
  changeBaselineLabel: string;
  /** Requested window half-width when a window was applied; otherwise null. */
  windowApplied: number | null;
  atmStrike: number | null;
  /**
   * How the window was centred.
   * - `atm`: closest strike to atmStrike
   * - `median`: atmStrike missing/invalid; centred on the middle strike so ±window still applies
   * - `none`: no window requested
   */
  windowCenter: "atm" | "median" | "none";
}

/** Exported for direct unit tests. Returns null when previous OI is missing or non-positive. */
export function changePct(oi: number | null, change: number | null): number | null {
  if (oi === null || change === null) return null;
  const previous = oi - change;
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return (change / previous) * 100;
}

function changeSign(change: number | null): OiChangeSign {
  if (change === null || !Number.isFinite(change)) return "missing";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

function mirroredPutPlot(putOi: number | null): number | null {
  if (putOi === null) return null;
  if (putOi === 0) return 0;
  return -putOi;
}

function toPoint(row: OiStrikeInput): OiByStrikePoint {
  const callOi = row.call?.openInterest ?? null;
  const putOi = row.put?.openInterest ?? null;
  const callOiChange = row.call?.openInterestChange ?? null;
  const putOiChange = row.put?.openInterestChange ?? null;
  return {
    strike: row.strikePrice,
    callOi,
    putOi,
    callOiChange,
    putOiChange,
    callOiChangePct: changePct(callOi, callOiChange),
    putOiChangePct: changePct(putOi, putOiChange),
    callChangeSign: changeSign(callOiChange),
    putChangeSign: changeSign(putOiChange),
    callOiPlot: callOi,
    putOiPlot: mirroredPutPlot(putOi),
  };
}

function indexClosestTo(sorted: readonly OiStrikeInput[], target: number): number {
  let bestIndex = 0;
  let bestDistance = Math.abs(sorted[0]!.strikePrice - target);
  for (let i = 1; i < sorted.length; i += 1) {
    const distance = Math.abs(sorted[i]!.strikePrice - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Build chart series from strike rows.
 *
 * - Sorts by strike ascending (input order ignored).
 * - Optional ±window strikes around ATM, or around the median strike when ATM is missing.
 * - Window clamps at the chain edges (short wing on that side).
 * - Preserves null OI distinctly from 0.
 */
export function buildOiByStrike(
  strikes: readonly OiStrikeInput[],
  options: BuildOiByStrikeOptions = {},
): BuildOiByStrikeResult {
  const sorted = [...strikes].sort((a, b) => a.strikePrice - b.strikePrice);
  const atmStrike = options.atmStrike ?? null;
  const window = options.window ?? null;

  let selected = sorted;
  let windowApplied: number | null = null;
  let windowCenter: BuildOiByStrikeResult["windowCenter"] = "none";

  if (window !== null && window >= 0 && sorted.length > 0) {
    const hasAtm = atmStrike !== null && Number.isFinite(atmStrike);
    const centerIndex = hasAtm
      ? indexClosestTo(sorted, atmStrike)
      : Math.floor((sorted.length - 1) / 2);
    windowCenter = hasAtm ? "atm" : "median";
    const from = Math.max(0, centerIndex - window);
    const to = Math.min(sorted.length - 1, centerIndex + window);
    selected = sorted.slice(from, to + 1);
    windowApplied = window;
  }

  return {
    points: selected.map(toPoint),
    unitLabel: OI_AXIS_UNIT_LABEL,
    changeBaselineLabel: OI_CHANGE_BASELINE_LABEL,
    windowApplied,
    atmStrike,
    windowCenter,
  };
}
