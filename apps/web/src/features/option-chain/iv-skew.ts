/**
 * The shape of the implied-volatility smile in three numbers, and how it moves from one session to the next. Pure, no React.
 *
 * The Greeks chart already plots IV against strike; this puts a number on its tilt and its curvature, read off the stored chain.
 *
 * - **25-delta risk reversal** = IV of the 25-delta call minus IV of the 25-delta put, in volatility points. Positive: the call wing is
 *   priced above the put wing; negative: the reverse. It describes prices, not a forecast.
 * - **25-delta butterfly** = the mean of the two 25-delta IVs minus the 50-delta (at-the-money) IV: how far the wings sit above the middle.
 *
 * ## What "25-delta" means here, and what it costs
 * The delta is the model's own (Black-Scholes at each contract's solved IV, on the parity forward), not an exchange figure. A contract's
 * delta moves with the IV that was solved for it, so the strike that is "25-delta" is itself a function of the smile being measured.
 * That is the usual convention and is stated, not hidden.
 *
 * ## What is refused, rather than extrapolated
 * Each of the three IVs is found by interpolating linearly in delta between the two solved contracts, adjacent in strike, whose
 * |delta| straddle the target. It is refused (null, with the reason) when
 * - no pair straddles it (the stored strike window does not reach that far; the reach is reported),
 * - more than one pair straddles it (the deltas are not monotone in strike, so there is no single answer),
 * - or the two contracts are more than 0.20 of delta apart (the interpolation would cover too wide a stretch).
 * A contract with no solved IV or delta is not a point; it is never filled in.
 *
 * ## The history rule
 * With four or more sessions that have a risk reversal, the newest is called outside when it is below the smallest or above the largest
 * of the earlier ones. That flags a change; four points are not a distribution, and the sentence says so.
 */
import type { GreeksStrikeInput } from "./build-greeks-by-strike";

export const WING_DELTA = 0.25;
export const MIDDLE_DELTA = 0.5;
/** The widest stretch of delta one interpolation may cover. */
export const MAX_DELTA_SPAN = 0.2;
export const HISTORY_MIN_SESSIONS = 4;

export type Side = "call" | "put";

interface Point {
  strike: number;
  absDelta: number;
  iv: number;
}

export interface IvAtDelta {
  /** Fraction (0.155 = 15.5%). Null when refused. */
  iv: number | null;
  /** The two strikes interpolated between. */
  between: [number, number] | null;
  refusal: string | null;
}

export interface Skew {
  put25: IvAtDelta;
  call25: IvAtDelta;
  middle: IvAtDelta;
  /** Volatility points. Null unless both wings were found. */
  riskReversal: number | null;
  /** Volatility points. Null unless all three were found. */
  butterfly: number | null;
}

function pointsOf(strikes: readonly GreeksStrikeInput[], side: Side): Point[] {
  const points: Point[] = [];
  for (const row of strikes) {
    const leg = row[side];
    if (!leg || leg.impliedVolatility === null || leg.delta === null) continue;
    if (!Number.isFinite(leg.impliedVolatility) || !Number.isFinite(leg.delta)) continue;
    points.push({ strike: row.strikePrice, absDelta: Math.abs(leg.delta), iv: leg.impliedVolatility });
  }
  return points.sort((a, b) => a.strike - b.strike);
}

const two = (value: number) => value.toFixed(2);

/** IV where |delta| equals `target`, from the solved contracts of one side. */
export function ivAtDelta(strikes: readonly GreeksStrikeInput[], side: Side, target: number): IvAtDelta {
  const points = pointsOf(strikes, side);
  const label = `${side === "put" ? "put" : "call"} |delta| ${two(target)}`;
  if (points.length < 2) {
    return { iv: null, between: null, refusal: `Fewer than two solved ${side}s, so ${label} cannot be placed.` };
  }
  // A contract sitting exactly on the target is the answer; two of them are not.
  const exact = points.filter((point) => point.absDelta === target);
  if (exact.length === 1) return { iv: exact[0]!.iv, between: [exact[0]!.strike, exact[0]!.strike], refusal: null };
  if (exact.length > 1) {
    return { iv: null, between: null, refusal: `${label} is hit exactly by more than one ${side}, so there is no single answer.` };
  }
  const crossings: Array<[Point, Point]> = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if ((a.absDelta - target) * (b.absDelta - target) < 0) crossings.push([a, b]);
  }
  if (crossings.length === 0) {
    const deltas = points.map((point) => point.absDelta);
    return { iv: null, between: null, refusal: `No two solved ${side}s straddle ${label}: the stored ${side} deltas reach ${two(Math.min(...deltas))} to ${two(Math.max(...deltas))}.` };
  }
  if (crossings.length > 1) {
    return { iv: null, between: null, refusal: `${label} is straddled by more than one pair of ${side}s (delta is not monotone in strike), so there is no single answer.` };
  }
  const [a, b] = crossings[0]!;
  const span = Math.abs(a.absDelta - b.absDelta);
  if (span > MAX_DELTA_SPAN) {
    return { iv: null, between: null, refusal: `The ${side}s straddling ${label} (${a.strike} and ${b.strike}) are ${two(span)} of delta apart, wider than the ${two(MAX_DELTA_SPAN)} allowed.` };
  }
  const iv = a.iv + ((target - a.absDelta) / (b.absDelta - a.absDelta)) * (b.iv - a.iv);
  return { iv, between: [a.strike, b.strike], refusal: null };
}

export function buildSkew(strikes: readonly GreeksStrikeInput[]): Skew {
  const put25 = ivAtDelta(strikes, "put", WING_DELTA);
  const call25 = ivAtDelta(strikes, "call", WING_DELTA);
  const middle = ivAtDelta(strikes, "call", MIDDLE_DELTA);
  const riskReversal = put25.iv !== null && call25.iv !== null ? (call25.iv - put25.iv) * 100 : null;
  const butterfly = put25.iv !== null && call25.iv !== null && middle.iv !== null
    ? ((call25.iv + put25.iv) / 2 - middle.iv) * 100
    : null;
  return { put25, call25, middle, riskReversal, butterfly };
}

/** Volatility points to two places, signed, rounded before the sign is read so a value that shows as 0.00 has no sign. */
export function formatPoints(value: number | null): string {
  if (value === null) return "–";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(2)}`;
}

/** An IV fraction as volatility points, unsigned: 0.155 -> "15.50". */
export function formatIv(value: number | null): string {
  return value === null ? "–" : (value * 100).toFixed(2);
}

/** What the snapshot shows, in a sentence, or why it cannot be said. */
export function skewSentence(skew: Skew): string {
  if (skew.riskReversal === null) {
    const reasons = [skew.put25.refusal, skew.call25.refusal].filter((reason): reason is string => reason !== null);
    return `The 25-delta risk reversal cannot be computed. ${reasons.join(" ")}`;
  }
  const callIv = formatIv(skew.call25.iv);
  const putIv = formatIv(skew.put25.iv);
  const rounded = Math.round(skew.riskReversal * 100) / 100;
  const relation = rounded === 0
    ? "level with"
    : rounded > 0
      ? `${Math.abs(rounded).toFixed(2)} points above`
      : `${Math.abs(rounded).toFixed(2)} points below`;
  return `The 25-delta call is priced at ${callIv} volatility points, ${relation} the 25-delta put at ${putIv}: a risk reversal of ${formatPoints(skew.riskReversal)}.`;
}

export interface SessionSkew {
  sessionDate: string;
  observedAt: string;
  /** Null when the chain for that session could not be read. */
  skew: Skew | null;
  error: string | null;
}

/** The newest session's risk reversal against the range of the earlier ones, or why that cannot be said. */
export function historySentence(sessions: readonly SessionSkew[]): string {
  const withValue = sessions.filter((session) => session.skew?.riskReversal != null);
  if (withValue.length < HISTORY_MIN_SESSIONS) {
    return `${withValue.length} of the ${sessions.length} sessions have a risk reversal; at least ${HISTORY_MIN_SESSIONS} are needed before it can be said whether the skew moves.`;
  }
  const [newest, ...earlier] = withValue;
  const values = earlier.map((session) => session.skew!.riskReversal!);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const latest = newest!.skew!.riskReversal!;
  const range = `${formatPoints(low)} to ${formatPoints(high)}`;
  const where = latest < low || latest > high ? "outside" : "inside";
  return `The newest session's risk reversal (${formatPoints(latest)} volatility points) is ${where} the range of the ${earlier.length} earlier sessions (${range}). This flags a change, it does not test one: ${earlier.length + 1} sessions are not a distribution.`;
}

export const IV_SKEW_DEFINITIONS = {
  riskReversal: "IV of the 25-delta call minus IV of the 25-delta put, in volatility points. Positive means the call wing is priced above the put wing. A statement about prices, not a forecast.",
  butterfly: "The mean of the 25-delta call and put IVs minus the 50-delta IV: how far the wings sit above the middle of the smile.",
  delta: "The model's delta (Black-Scholes at each contract's solved IV, on the parity forward), not an exchange figure. The strike that is 25-delta depends on the smile being measured.",
  refusal: "Each IV is interpolated linearly in delta between the two solved contracts, adjacent in strike, that straddle the target. It is refused, never extrapolated, when none does, when more than one pair does, or when the pair is more than 0.20 of delta apart. A contract with no solved IV is not a point.",
  history: "Each row is the last in-session chain of a trading session. With four or more sessions that have a risk reversal, the newest is called outside when it is below the smallest or above the largest of the earlier ones. That flags a change; it is not a significance test.",
} as const;
