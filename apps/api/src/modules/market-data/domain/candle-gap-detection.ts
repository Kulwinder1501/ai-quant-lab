/**
 * Classifies a completed trading session's one-minute coverage as complete, internally holed, or
 * merely short at the edges.
 *
 * ## Why this distinction is the whole point
 *
 * A live intraday collector fetches only the most recent bars each minute, so it cannot self-heal: a
 * minute missed while the scheduler was down or crashing stays missing until someone backfills. In
 * August 2026 that happened across 08-07..08-13 and was discovered *by accident* weeks later, through a
 * research readiness check. The failure was not the gap — gaps happen when a process dies — it was
 * that the gap was silent.
 *
 * So this exists to make a gap loud the same day. But it must not cry wolf, and the classification
 * below is what keeps it honest — and the distinction turns on the market open, not merely on holes:
 *
 * - **CONFIRMED_GAP** — the session is missing its open, or missing a minute strictly between two
 *   present ones. Both are unambiguous. NSE regular sessions always open at 09:15, so a first bar
 *   later than the open means the open was missed (08-07 and 08-11 were exactly this — a late collector
 *   start, verifiably a miss), and a hole between live bars is a miss by definition. This is the signal
 *   worth failing a job over.
 * - **TAIL_SHORT** — present contiguously from the open but ending early. Genuinely ambiguous: a
 *   half-day closes early on purpose, and so does a collector that stopped early. Reported, never
 *   escalated, because escalating it would raise a false alarm on every legitimate short session.
 * - **COMPLETE** — every expected minute present.
 *
 * A special evening session (Muhurat) does not open at 09:15 at all, so its bars do not belong in a
 * regular-session window; the caller must exclude such days rather than feed them here, or every open
 * index would read as missing. This function judges a regular session's shape and nothing else.
 */

export type SessionCoverageKind = "COMPLETE" | "CONFIRMED_GAP" | "TAIL_SHORT";

export interface SessionCoverage {
  readonly kind: SessionCoverageKind;
  readonly barsPresent: number;
  readonly barsExpected: number;
  /** True when the session's opening minute is absent — an unambiguous miss on its own. */
  readonly openMissing: boolean;
  /** Missing minutes strictly between the first and last present bar. */
  readonly interiorMissing: number;
  /** Human-readable one-liner for a log or a job-failure message. */
  readonly summary: string;
}

export interface SessionCoverageInput {
  /** Minute-of-session index of each present bar, 0-based, within one session. Order-independent. */
  readonly presentMinuteIndices: readonly number[];
  /** Bars a full session of this timeframe holds. NSE regular session at 1m is 375. */
  readonly barsExpected: number;
}

/**
 * Classifies one regular session from the set of minute indices present.
 *
 * Minute indices rather than timestamps so the rule is timezone- and timeframe-agnostic: the caller
 * maps each bar's close to `floor((close - sessionOpen) / barLength)`. Index 0 is the opening bar.
 */
export function classifySessionCoverage(input: SessionCoverageInput): SessionCoverage {
  if (!Number.isInteger(input.barsExpected) || input.barsExpected <= 0) {
    throw new Error("barsExpected must be a positive integer.");
  }
  // Indices at or beyond the expected count do not belong to a regular session — most likely a special
  // session fed in by mistake. Refused rather than silently classified, because a misaligned window
  // would make the open look missing and cry wolf.
  const present = new Set(input.presentMinuteIndices);
  for (const index of present) {
    if (!Number.isInteger(index) || index < 0 || index >= input.barsExpected) {
      throw new Error(`Minute index ${index} is outside the regular session [0, ${input.barsExpected}).`);
    }
  }
  const barsPresent = present.size;

  if (barsPresent === 0) {
    return {
      kind: "CONFIRMED_GAP",
      barsPresent: 0,
      barsExpected: input.barsExpected,
      openMissing: true,
      interiorMissing: 0,
      summary: `no bars at all against ${input.barsExpected} expected — the whole session is missing`,
    };
  }

  const firstPresent = Math.min(...present);
  const lastPresent = Math.max(...present);
  const openMissing = firstPresent > 0;

  let interiorMissing = 0;
  for (let index = firstPresent + 1; index < lastPresent; index += 1) {
    if (!present.has(index)) interiorMissing += 1;
  }

  if (openMissing || interiorMissing > 0) {
    const reasons = [
      openMissing ? `open missing (first bar at minute ${firstPresent})` : null,
      interiorMissing > 0 ? `${interiorMissing} interior minute(s) missing` : null,
    ].filter(Boolean).join(", ");
    return {
      kind: "CONFIRMED_GAP",
      barsPresent,
      barsExpected: input.barsExpected,
      openMissing,
      interiorMissing,
      summary: `${reasons} (${barsPresent}/${input.barsExpected} present) — an unambiguous collection miss`,
    };
  }

  if (barsPresent < input.barsExpected) {
    return {
      kind: "TAIL_SHORT",
      barsPresent,
      barsExpected: input.barsExpected,
      openMissing: false,
      interiorMissing: 0,
      summary: `${barsPresent}/${input.barsExpected} bars, contiguous from the open but ending early — `
        + `a genuine half-day or an early collector stop; ambiguous`,
    };
  }

  return {
    kind: "COMPLETE",
    barsPresent,
    barsExpected: input.barsExpected,
    openMissing: false,
    interiorMissing: 0,
    summary: `complete (${barsPresent}/${input.barsExpected})`,
  };
}
