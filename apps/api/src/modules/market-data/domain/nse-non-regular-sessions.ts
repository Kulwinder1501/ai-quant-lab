import type { NonRegularSessionWindow } from "../../platform/calendar/trading-session.js";

/**
 * Exchange-announced sessions that do not have the regular weekday 09:15-15:30 shape.
 *
 * ## Why each entry now carries a window
 *
 * This catalogue previously recorded only a date and a reason, which is enough to *exclude* a session
 * from an experiment but not to say when it traded. That gap produced two live defects, measured
 * against the stored tape for all eight entries:
 *
 * - Four of the eight fall on a Saturday or Sunday, and `NseMarketSession` decides tradability from
 *   the weekday, so it reports them closed. Between 105 and 750 bars per instrument exist for each.
 * - Two fall on a weekday and had **no** regular trading at all (2024-11-01 Diwali, 2025-10-21
 *   Diwali). The calendar reports them as ordinary 09:15-15:30 days.
 *
 * None of the eight is in `nse_holidays`, so no amount of holiday-list maintenance would have fixed
 * either case. `resolveTradingSession` gives a declared session precedence over the weekday rule,
 * which is why the window has to live here.
 *
 * ## Provenance is recorded per entry, and it is not uniform
 *
 * `windowProvenance` distinguishes a window taken from the circular from one inferred from bars we
 * received. The distinction earns its place immediately: 2025-10-21 carries **61 one-minute bars per
 * instrument where its announced 13:45-14:45 window allows 60**, the extra one opening at 14:45. The
 * announced close is recorded rather than the observed last bar, so that bar stays detectable as an
 * anomaly instead of being legitimised by the calendar it contradicts.
 *
 * Windows below were cross-checked against stored 1m bars on 2026-08-31 (first and last bar open per
 * instrument); the three Muhurat sessions match their circulars exactly. The Saturday/Sunday sittings
 * are marked `OBSERVED_FROM_TAPE` because the circular reference on file announces the sitting without
 * a timetable this catalogue can cite.
 */
export interface KnownNseNonRegularSession extends NonRegularSessionWindow {
  readonly sessionDate: string;
  readonly reason: string;
  readonly circularReference: string;
}

const ist = (hour: number, minute: number): number => hour * 60 + minute;

export const KNOWN_NSE_NON_REGULAR_SESSIONS_V1: readonly KnownNseNonRegularSession[] = [
  {
    sessionDate: "2023-11-12", reason: "Diwali Muhurat evening session", circularReference: "NSE/CMTR/59124",
    // Sunday. Observed 18:15 - 19:14 last bar open, i.e. a 19:15 close: 60 bars, matching the circular.
    opensAtIstMinute: ist(18, 15), closesAtIstMinute: ist(19, 15), windowProvenance: "CIRCULAR",
  },
  {
    sessionDate: "2024-01-20", reason: "Saturday live trading session", circularReference: "NSE/MSD/60340",
    // Saturday, full regular shape: 750 bars, 09:15 - 15:29 last bar open.
    opensAtIstMinute: ist(9, 15), closesAtIstMinute: ist(15, 30), windowProvenance: "OBSERVED_FROM_TAPE",
  },
  {
    sessionDate: "2024-03-02", reason: "Saturday primary/DR special live sessions", circularReference: "NSE/MSD/60677",
    // Saturday half day: 105 bars, 09:15 - 12:29 last bar open.
    opensAtIstMinute: ist(9, 15), closesAtIstMinute: ist(12, 30), windowProvenance: "OBSERVED_FROM_TAPE",
  },
  {
    sessionDate: "2024-05-18", reason: "Saturday primary/DR special live sessions", circularReference: "NSE/MSD/61893",
    // Saturday half day: 105 bars, 09:15 - 12:29 last bar open.
    opensAtIstMinute: ist(9, 15), closesAtIstMinute: ist(12, 30), windowProvenance: "OBSERVED_FROM_TAPE",
  },
  {
    sessionDate: "2024-11-01", reason: "Diwali Muhurat evening session", circularReference: "NSE/CMTR/64628",
    // Friday, and there was no regular session: 60 bars, 18:00 - 18:59 last bar open. The calendar
    // currently calls this an ordinary 09:15-15:30 weekday.
    opensAtIstMinute: ist(18, 0), closesAtIstMinute: ist(19, 0), windowProvenance: "CIRCULAR",
  },
  {
    sessionDate: "2025-02-01", reason: "Saturday Union Budget live session", circularReference: "NSE/CMTR/65729",
    opensAtIstMinute: ist(9, 15), closesAtIstMinute: ist(15, 30), windowProvenance: "OBSERVED_FROM_TAPE",
  },
  {
    sessionDate: "2025-10-21", reason: "Diwali Muhurat afternoon session", circularReference: "NSE/CMTR/70319",
    // Tuesday, no regular session. 61 bars against the 60 this window allows -- one opening at 14:45,
    // past the announced close. The announced close is recorded so that bar stays an anomaly.
    opensAtIstMinute: ist(13, 45), closesAtIstMinute: ist(14, 45), windowProvenance: "CIRCULAR",
  },
  {
    sessionDate: "2026-02-01", reason: "Sunday Union Budget live session", circularReference: "NSE/CMTR/72349",
    opensAtIstMinute: ist(9, 15), closesAtIstMinute: ist(15, 30), windowProvenance: "OBSERVED_FROM_TAPE",
  },
] as const;

export function knownNseNonRegularSessionMap(): ReadonlyMap<string, KnownNseNonRegularSession> {
  return new Map(KNOWN_NSE_NON_REGULAR_SESSIONS_V1.map((session) => [session.sessionDate, session]));
}

/**
 * The regular shapes, kept here rather than duplicated at call sites.
 *
 * The 09:16 / 15:30 pair appears as bare integers in at least two research CLIs
 * (`REGULAR_SESSION_FIRST_CLOSE = 556`, `REGULAR_FIRST_CLOSE = 556`) and as SQL literals in the
 * acceptance repository. Those are the same fact written four times under three names, which is how
 * one of them silently stops matching the others.
 */
export const NSE_REGULAR_SESSION_OPEN_IST_MINUTE = ist(9, 15);
export const NSE_CASH_CLOSE_IST_MINUTE = ist(15, 30);
/** Equity derivatives ring a later bell; see `nse-market-session.ts` for the dated provenance. */
export const NSE_DERIVATIVES_CLOSE_IST_MINUTE = ist(15, 40);
export const NSE_DERIVATIVES_CLOSE_EFFECTIVE_FROM = "2026-08-03";
