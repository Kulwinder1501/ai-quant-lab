/**
 * Exchange-agnostic resolution of "was this a trading day, and between which instants".
 *
 * ## The two defects this exists to fix, both measured
 *
 * `NseMarketSession` decides tradability from the weekday and a holiday set, then computes a
 * 09:15-15:30 (cash) or 09:15-15:40 (derivatives) window. The catalogue of non-regular sessions
 * records only a *date* and a reason, never a window. Checked against the stored tape for all eight
 * known non-regular sessions, that produces two opposite errors:
 *
 * | Session | Weekday | Observed window (IST) | What the calendar says |
 * | :--- | :--- | :--- | :--- |
 * | 2023-11-12 Muhurat evening | Sun | 18:15 - 19:15 | CLOSED (weekend) |
 * | 2024-01-20 Saturday live | Sat | 09:15 - 15:30 | CLOSED (weekend) |
 * | 2024-03-02 Saturday live | Sat | 09:15 - 12:30 | CLOSED (weekend) |
 * | 2024-05-18 Saturday live | Sat | 09:15 - 12:30 | CLOSED (weekend) |
 * | 2024-11-01 Muhurat evening | Fri | 18:00 - 19:00 | **REGULAR 09:15-15:30** |
 * | 2025-02-01 Saturday Budget | Sat | 09:15 - 15:30 | CLOSED (weekend) |
 * | 2025-10-21 Muhurat afternoon | Tue | 13:45 - 14:45 | **REGULAR 09:15-15:30** |
 * | 2026-02-01 Sunday Budget | Sun | 09:15 - 15:30 | CLOSED (weekend) |
 *
 * So: four sessions with 105-750 bars per instrument on the tape are reported closed, and two
 * weekday sessions that had *no* regular trading are reported as ordinary 09:15-15:30 days. None of
 * the eight appears in `nse_holidays`.
 *
 * The fix is structural rather than a longer holiday list. A declared non-regular session carries its
 * own window and **overrides the weekday rule**, because the exchange's announcement is the authority
 * on whether it traded, not the day of the week.
 *
 * ## Why the resolution lives here and the NSE catalogue does not
 *
 * Platform P0 owns the contract; the exchange's dated facts stay in `market-data`. This module never
 * mentions NSE, 09:15, or Muhurat — it takes the windows as input. That keeps the platform layer from
 * acquiring a dependency on one exchange's timetable, which is the coupling Gap 1 exists to avoid.
 */

export type SessionKind = "REGULAR" | "NON_REGULAR" | "CLOSED";

/** A session whose shape the exchange announced separately. Half day, evening, or a weekend sitting. */
export interface NonRegularSessionWindow {
  /** IST calendar date, `YYYY-MM-DD`. */
  readonly sessionDate: string;
  /** Minutes past IST midnight at which the first bar opens. */
  readonly opensAtIstMinute: number;
  /** Minutes past IST midnight at which the session closes. Exclusive: no bar opens at this minute. */
  readonly closesAtIstMinute: number;
  readonly reason: string;
  /** The exchange circular, so a window is auditable rather than folklore. */
  readonly circularReference: string;
  /**
   * Whether the window came from the circular or was inferred from stored bars.
   *
   * Not decoration. An `OBSERVED_FROM_TAPE` window is a measurement of what our collector received,
   * which can include artefacts -- 2025-10-21 carries one bar past its announced close -- so a rule
   * derived from it must not be mistaken for the exchange's own statement.
   */
  readonly windowProvenance: "CIRCULAR" | "OBSERVED_FROM_TAPE";
}

export interface RegularSessionShape {
  readonly opensAtIstMinute: number;
  /** Exclusive, and segment-specific: cash and derivatives ring different bells. */
  readonly closesAtIstMinute: number;
}

export interface TradingSession {
  readonly sessionDate: string;
  readonly kind: SessionKind;
  /** Null only when `kind` is `CLOSED`. */
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly reason: string | null;
  readonly circularReference: string | null;
  readonly windowProvenance: "REGULAR_SHAPE" | "CIRCULAR" | "OBSERVED_FROM_TAPE" | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The IST calendar date of an instant, as `YYYY-MM-DD`. */
export function istSessionDate(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error("An instant must be a valid Date.");
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of an IST minute-of-day on a given IST date. */
export function istInstant(sessionDate: string, istMinute: number): Date {
  if (!DATE_PATTERN.test(sessionDate)) throw new Error(`A session date must be YYYY-MM-DD; got "${sessionDate}".`);
  if (!Number.isInteger(istMinute) || istMinute < 0 || istMinute > 24 * 60) {
    throw new Error(`An IST minute-of-day must be an integer in [0, 1440]; got ${istMinute}.`);
  }
  return new Date(Date.parse(`${sessionDate}T00:00:00.000Z`) + istMinute * 60_000 - IST_OFFSET_MS);
}

/** Saturday or Sunday in IST. Only ever a *default*, never a conclusion. */
function isIstWeekend(sessionDate: string): boolean {
  const weekday = new Date(`${sessionDate}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Resolves one IST date into a session.
 *
 * Precedence is the whole point, and it is deliberately not the order a reader might guess:
 *
 * 1. **A declared non-regular session wins.** The exchange announced it traded, which settles the
 *    question regardless of weekday or holiday-list membership. Every one of the eight known
 *    non-regular sessions is absent from `nse_holidays`, and four fall on a weekend, so any rule that
 *    checked those first would report four live sessions closed.
 * 2. A holiday is closed.
 * 3. A weekend is closed.
 * 4. Otherwise regular, with the segment's own shape.
 *
 * `holidays` and `nonRegularSessions` are supplied by the caller rather than read from a module-level
 * table, so the same function serves a live scheduler and a historical audit without either mutating
 * shared state.
 */
export function resolveTradingSession(input: {
  readonly sessionDate: string;
  readonly regularShape: RegularSessionShape;
  readonly holidays: ReadonlySet<string>;
  readonly nonRegularSessions: ReadonlyMap<string, NonRegularSessionWindow>;
}): TradingSession {
  if (!DATE_PATTERN.test(input.sessionDate)) {
    throw new Error(`A session date must be YYYY-MM-DD; got "${input.sessionDate}".`);
  }
  const { opensAtIstMinute, closesAtIstMinute } = input.regularShape;
  if (closesAtIstMinute <= opensAtIstMinute) {
    throw new Error("A regular session must close after it opens.");
  }

  const declared = input.nonRegularSessions.get(input.sessionDate);
  if (declared) {
    if (declared.closesAtIstMinute <= declared.opensAtIstMinute) {
      throw new Error(`Non-regular session ${input.sessionDate} must close after it opens.`);
    }
    return {
      sessionDate: input.sessionDate,
      kind: "NON_REGULAR",
      opensAt: istInstant(input.sessionDate, declared.opensAtIstMinute),
      closesAt: istInstant(input.sessionDate, declared.closesAtIstMinute),
      reason: declared.reason,
      circularReference: declared.circularReference,
      windowProvenance: declared.windowProvenance,
    };
  }

  if (input.holidays.has(input.sessionDate) || isIstWeekend(input.sessionDate)) {
    return {
      sessionDate: input.sessionDate,
      kind: "CLOSED",
      opensAt: null,
      closesAt: null,
      reason: input.holidays.has(input.sessionDate) ? "Exchange holiday" : "Weekend",
      circularReference: null,
      windowProvenance: null,
    };
  }

  return {
    sessionDate: input.sessionDate,
    kind: "REGULAR",
    opensAt: istInstant(input.sessionDate, opensAtIstMinute),
    closesAt: istInstant(input.sessionDate, closesAtIstMinute),
    reason: null,
    circularReference: null,
    windowProvenance: "REGULAR_SHAPE",
  };
}

/**
 * Whether an instant falls inside its own session.
 *
 * Half-open, `[opensAt, closesAt)`, matching how a bar is named by its open: the bar opening at the
 * closing minute does not belong to the session. That convention is what makes the extra bar observed
 * at 2025-10-21 14:45 -- one past the announced close -- visible as an anomaly rather than quietly
 * absorbed.
 */
export function isWithinSession(instant: Date, session: TradingSession): boolean {
  if (session.opensAt === null || session.closesAt === null) return false;
  const time = instant.getTime();
  return time >= session.opensAt.getTime() && time < session.closesAt.getTime();
}
