/**
 * How the model-against-Fyers Greeks gap moves from one session to the next. Pure, no React.
 *
 * `vendor-greeks-check.ts` compares the two sets of Greeks on one stored snapshot. A single day's gap says little about whether
 * either route is drifting: a solver change, a different forward, or a change on the provider's side would all show first as a
 * bias that was steady and then is not. This module takes that comparison for the last in-session snapshot of each of the newest
 * sessions and sets the days side by side.
 *
 * Only what was stored can be compared. A session whose chain was collected before the provider's Greeks were (everything up to the
 * first weekday run after the 2026-10-24 deploy) has none, and is shown as such, never as agreement.
 *
 * ## The drift rule
 * With four or more sessions that have an IV pair, the newest session's IV bias is "outside" when it falls below the smallest or
 * above the largest bias of the earlier ones. That is a flag that something moved, not a test of significance: four points do not
 * make a distribution, and the sentence says so. With fewer sessions it says there are too few to say anything.
 */
import type { GreeksStrikeInput, VendorGreeksInput } from "./build-greeks-by-strike";
import type { StrikeRow } from "./live-chain";
import { formatDifference, type AgreementSummary, type MetricAgreement } from "./vendor-greeks-check";

export const DRIFT_MIN_SESSIONS = 4;

/** What the chain route returns per leg that the comparison reads, narrowed so the mapping is explicit. */
export function toGreeksStrikes(strikes: readonly StrikeRow[]): GreeksStrikeInput[] {
  const leg = (value: StrikeRow["call"]) => (value
    ? {
      impliedVolatility: value.impliedVolatility,
      impliedVolatilityRefusal: value.impliedVolatilityRefusal,
      delta: value.delta,
      gamma: value.gamma,
      theta: value.theta,
      vega: value.vega,
      vendorGreeks: (value.vendorGreeks ?? null) as VendorGreeksInput | null,
    }
    : null);
  return strikes.map((row) => ({ strikePrice: row.strikePrice, call: leg(row.call), put: leg(row.put) }));
}

export interface SessionAgreement {
  sessionDate: string;
  observedAt: string;
  /** Null when the chain for that session could not be read (see `error`). */
  summary: AgreementSummary | null;
  error: string | null;
}

export type RowState = "compared" | "no-vendor" | "no-pairs" | "unavailable";

export interface HistoryRow {
  sessionDate: string;
  observedAt: string;
  state: RowState;
  legs: number;
  legsWithVendor: number;
  iv: MetricAgreement | null;
  delta: MetricAgreement | null;
}

function metric(summary: AgreementSummary, name: "iv" | "delta"): MetricAgreement | null {
  const found = summary.metrics.find((entry) => entry.metric === name);
  return found && found.compared > 0 ? found : null;
}

/** One row per session, in the order given (newest first). */
export function buildHistory(sessions: readonly SessionAgreement[]): HistoryRow[] {
  return sessions.map((session): HistoryRow => {
    if (session.summary === null) return { sessionDate: session.sessionDate, observedAt: session.observedAt, state: "unavailable", legs: 0, legsWithVendor: 0, iv: null, delta: null };
    const { summary } = session;
    const iv = metric(summary, "iv");
    const delta = metric(summary, "delta");
    const state: RowState = summary.legsWithVendor === 0 ? "no-vendor" : iv === null && delta === null ? "no-pairs" : "compared";
    return { sessionDate: session.sessionDate, observedAt: session.observedAt, state, legs: summary.legs, legsWithVendor: summary.legsWithVendor, iv, delta };
  });
}

export function stateText(row: HistoryRow): string {
  switch (row.state) {
    case "compared": return `${row.legsWithVendor} of ${row.legs} contracts carry Fyers Greeks`;
    case "no-vendor": return "no Fyers Greeks stored that session";
    case "no-pairs": return "Fyers Greeks stored, but no contract has both values";
    case "unavailable": return "chain could not be read";
  }
}

/** The newest session's IV bias against the range of the earlier ones, or why that cannot be said. */
export function driftSentence(rows: readonly HistoryRow[]): string {
  const withIv = rows.filter((row) => row.iv !== null);
  if (withIv.length < DRIFT_MIN_SESSIONS) {
    return `${withIv.length} of the ${rows.length} sessions have an IV comparison; at least ${DRIFT_MIN_SESSIONS} are needed before it can be said whether the gap moves.`;
  }
  const [newest, ...earlier] = withIv;
  const biases = earlier.map((row) => row.iv!.bias!);
  const low = Math.min(...biases);
  const high = Math.max(...biases);
  const latest = newest!.iv!.bias!;
  const range = `${formatDifference("iv", low)} to ${formatDifference("iv", high)}`;
  const caveat = ` This flags a change, it does not test one: ${earlier.length + 1} sessions are not a distribution.`;
  if (latest < low || latest > high) {
    return `The newest session's IV bias (${formatDifference("iv", latest)} volatility points) is outside the range of the ${earlier.length} earlier sessions (${range}).${caveat}`;
  }
  return `The newest session's IV bias (${formatDifference("iv", latest)} volatility points) is inside the range of the ${earlier.length} earlier sessions (${range}).${caveat}`;
}

export const VENDOR_HISTORY_DEFINITIONS = {
  sessions: "Each row is the comparison of the model's Greeks with Fyers' own on the last chain snapshot taken inside a trading session (09:15 to 15:30 IST); the pre-open and post-close snapshots and exchange holidays are left out.",
  noVendor: "Chains collected before the provider's Greeks were stored have none, and are shown as having none, never as agreement.",
  drift: "With four or more sessions that have an IV comparison, the newest session's IV bias is called outside when it is below the smallest or above the largest of the earlier ones. That flags that something moved; four points are not a distribution, so it is not a significance test.",
} as const;
