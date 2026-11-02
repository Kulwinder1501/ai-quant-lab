/**
 * How price behaved at these levels against arbitrary lines. Written to section 3 of
 * docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md, whose parameters are fixed there and not tuned.
 *
 * Pure: bars and lines in, outcomes out. The caller reads candles and builds the levels (with `dailyBarLevels`, the same construction
 * the sheet uses) and aggregates over sessions.
 */
import type { LevelFamily } from "./levels.js";

export interface IntradayBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export const STUDY_PARAMETERS = {
  /** A bar touches a line when its range comes within this fraction of it. */
  touchBand: 0.0005,
  /** A bounce or a break is a move of this fraction of the line's price. */
  moveFraction: 0.0025,
  /** Bars after the touch bar in which the outcome is looked for (8 x 15 minutes = two hours). */
  windowBars: 8,
  /** Placebo lines, as offsets from each real level. */
  placeboOffsets: [-0.005, -0.0035, 0.0035, 0.005],
  /** A placebo line is dropped if it falls this close to any real level that session. */
  placeboExclusion: 0.0015,
  bootstrapDraws: 5000,
  bootstrapSeed: 20261102,
} as const;

export type StudyFamily = LevelFamily | "ALL";
export type TouchSide = "RESISTANCE" | "SUPPORT";
export type TouchOutcome = "BOUNCE" | "BREAK" | "UNRESOLVED";

export interface StudyLine {
  readonly key: string;
  /** The family of the real level, also the family a placebo line was displaced from. */
  readonly family: LevelFamily;
  readonly kind: "REAL" | "PLACEBO";
  readonly price: number;
}

export interface TouchResult {
  readonly key: string;
  readonly family: LevelFamily;
  readonly kind: "REAL" | "PLACEBO";
  readonly side: TouchSide;
  readonly outcome: TouchOutcome;
  /** Index of the touch bar within the session. */
  readonly touchIndex: number;
}

/** Four displaced lines per real level, minus any that sit within the exclusion distance of a real level that session. */
export function placeboLines(real: ReadonlyArray<Pick<StudyLine, "key" | "family" | "price">>, parameters = STUDY_PARAMETERS): StudyLine[] {
  const lines: StudyLine[] = [];
  for (const level of real) {
    for (const offset of parameters.placeboOffsets) {
      const price = level.price * (1 + offset);
      const tooClose = real.some((other) => Math.abs(price - other.price) <= other.price * parameters.placeboExclusion);
      if (!tooClose) lines.push({ key: `${level.key}${offset > 0 ? "+" : ""}${(offset * 100).toFixed(2)}%`, family: level.family, kind: "PLACEBO", price });
    }
  }
  return lines;
}

/**
 * The first touch of each line in the session and what followed. The touch bar is the first whose range comes within the band; the test
 * side is set by the previous bar's close (the first bar uses `previousClose`). The outcome is first passage over the next
 * `windowBars` bars: a bounce is a move away from the line on the rejection side, a break is a move through it. A bar that reaches
 * both targets is UNRESOLVED, because the order inside it is not known.
 */
export function evaluateSession(
  bars: readonly IntradayBar[],
  previousClose: number,
  lines: readonly StudyLine[],
  parameters = STUDY_PARAMETERS,
): TouchResult[] {
  const results: TouchResult[] = [];
  for (const line of lines) {
    const touchIndex = bars.findIndex((bar) => bar.low <= line.price * (1 + parameters.touchBand) && bar.high >= line.price * (1 - parameters.touchBand));
    if (touchIndex < 0) continue;
    const before = touchIndex === 0 ? previousClose : bars[touchIndex - 1].close;
    const side: TouchSide = before < line.price ? "RESISTANCE" : "SUPPORT";
    const away = line.price * parameters.moveFraction;
    // From a resistance test a bounce is a fall of `away`, a break a rise of `away`; from a support test the reverse.
    const bounceLevel = side === "RESISTANCE" ? line.price - away : line.price + away;
    const breakLevel = side === "RESISTANCE" ? line.price + away : line.price - away;

    let outcome: TouchOutcome = "UNRESOLVED";
    const last = Math.min(bars.length - 1, touchIndex + parameters.windowBars);
    for (let index = touchIndex + 1; index <= last; index += 1) {
      const bar = bars[index];
      const bounced = side === "RESISTANCE" ? bar.low <= bounceLevel : bar.high >= bounceLevel;
      const broke = side === "RESISTANCE" ? bar.high >= breakLevel : bar.low <= breakLevel;
      if (bounced && broke) break; // both inside one bar: order unknown
      if (bounced) { outcome = "BOUNCE"; break; }
      if (broke) { outcome = "BREAK"; break; }
    }
    results.push({ key: line.key, family: line.family, kind: line.kind, side, outcome, touchIndex });
  }
  return results;
}

/** Per-session counts of resolved touches for one class of real lines and its placebo. */
export interface SessionCounts {
  readonly realBounce: number;
  readonly realBreak: number;
  readonly placeboBounce: number;
  readonly placeboBreak: number;
}

export function countSession(results: readonly TouchResult[], family: StudyFamily): SessionCounts {
  const counts = { realBounce: 0, realBreak: 0, placeboBounce: 0, placeboBreak: 0 };
  for (const result of results) {
    if (family !== "ALL" && result.family !== family) continue;
    if (result.outcome === "UNRESOLVED") continue;
    if (result.kind === "REAL") counts[result.outcome === "BOUNCE" ? "realBounce" : "realBreak"] += 1;
    else counts[result.outcome === "BOUNCE" ? "placeboBounce" : "placeboBreak"] += 1;
  }
  return counts;
}

/** Deterministic generator, so the interval is reproducible from the seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ReactionSummary {
  readonly family: StudyFamily;
  readonly sessions: number;
  readonly realResolved: number;
  readonly placeboResolved: number;
  /** BOUNCE share among resolved touches; null with no resolved touches. */
  readonly realBounceShare: number | null;
  readonly placeboBounceShare: number | null;
  /** Real minus placebo, in share points (0.05 = five percentage points); null when either share is undefined. */
  readonly difference: number | null;
  /** Day-clustered bootstrap 95% interval of the difference; null when it cannot be formed. */
  readonly lower: number | null;
  readonly upper: number | null;
}

const share = (bounce: number, broke: number): number | null => (bounce + broke > 0 ? bounce / (bounce + broke) : null);

function differenceOf(counts: readonly SessionCounts[]): { real: number | null; placebo: number | null; difference: number | null } {
  let realBounce = 0; let realBreak = 0; let placeboBounce = 0; let placeboBreak = 0;
  for (const day of counts) {
    realBounce += day.realBounce; realBreak += day.realBreak; placeboBounce += day.placeboBounce; placeboBreak += day.placeboBreak;
  }
  const real = share(realBounce, realBreak);
  const placebo = share(placeboBounce, placeboBreak);
  return { real, placebo, difference: real === null || placebo === null ? null : real - placebo };
}

/** The real-minus-placebo bounce share, with a bootstrap interval that resamples whole sessions (the unit that shares a market). */
export function summariseReaction(family: StudyFamily, perSession: readonly SessionCounts[], parameters = STUDY_PARAMETERS): ReactionSummary {
  const point = differenceOf(perSession);
  const realResolved = perSession.reduce((sum, day) => sum + day.realBounce + day.realBreak, 0);
  const placeboResolved = perSession.reduce((sum, day) => sum + day.placeboBounce + day.placeboBreak, 0);
  let lower: number | null = null;
  let upper: number | null = null;
  if (point.difference !== null && perSession.length > 1) {
    const random = mulberry32(parameters.bootstrapSeed);
    const draws: number[] = [];
    for (let draw = 0; draw < parameters.bootstrapDraws; draw += 1) {
      const sample: SessionCounts[] = [];
      for (let index = 0; index < perSession.length; index += 1) sample.push(perSession[Math.floor(random() * perSession.length)]);
      const result = differenceOf(sample).difference;
      if (result !== null) draws.push(result);
    }
    if (draws.length > 0) {
      draws.sort((a, b) => a - b);
      lower = draws[Math.floor(0.025 * (draws.length - 1))];
      upper = draws[Math.ceil(0.975 * (draws.length - 1))];
    }
  }
  return {
    family,
    sessions: perSession.length,
    realResolved,
    placeboResolved,
    realBounceShare: point.real,
    placeboBounceShare: point.placebo,
    difference: point.difference,
    lower,
    upper,
  };
}

/** The sentence shown beside the numbers. It states what the interval allows and nothing more. */
export function describeReaction(summary: ReactionSummary): string {
  if (summary.difference === null || summary.lower === null || summary.upper === null) return "Too few resolved touches to compare with random lines.";
  const points = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
  const range = `${points(summary.lower)} to ${points(summary.upper)} points`;
  if (summary.lower > 0) return `Bounced more often than random lines (${range}).`;
  if (summary.upper < 0) return `Bounced less often than random lines (${range}).`;
  return `No demonstrated difference from random lines (${range}).`;
}
