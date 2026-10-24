import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  assessBarQuality,
  buildSessionProfile,
  chooseCompositeSessions,
  COMPOSITE_DAY_CHOICES,
  COMPLETE_SESSION_MIN_BAR_SHARE,
  EXPECTED_SESSION_MINUTES,
  formatClockMinute,
  FULL_SESSION_RANGE,
  isFullSession,
  MIN_RANGE_MINUTES,
  parseClockMinute,
  profileSensitivity,
  RANGE_STEP_MINUTES,
  rangeProblem,
  selectBarsInRange,
  selectRegularSessionBars,
  SESSION_PROFILE_DEFINITIONS,
  summariseSession,
  type FuturesBar,
  type SessionProfile,
  type SessionRange,
} from "../../domain/session-volume-profile.js";
import { frontContractOn, istInstant, listStoredSessions } from "./session-listing.js";
import {
  SESSION_LOOKBACK_DAYS,
  istDate,
  parseChoice,
  parseUnderlyingAndDate,
  type IndexUnderlying,
} from "./session-query.js";

/** Row heights offered per index, in index points, with the default. Chosen so a typical session is 30-90 rows tall. */
export const PROFILE_ROW_CHOICES: Record<IndexUnderlying, { choices: readonly number[]; fallback: number }> = {
  BANKNIFTY: { choices: [5, 10, 20], fallback: 10 },
  NIFTY50: { choices: [2, 5, 10], fallback: 5 },
};

export type VolumeProfileQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; date: string | null; rowPoints: number; range: SessionRange; days: number } }
  | { ok: false; error: string };

/**
 * Validates `underlying`, `date`, `rowPoints` (the choices depend on the index) and the optional `from` / `to` window of
 * the session (`HH:MM`, IST). A missing edge is the session's own edge. Pure, so it is tested without a server.
 */
export function parseVolumeProfileQuery(
  input: {
    underlying: string | undefined;
    date: string | undefined;
    rowPoints: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    days?: string | undefined;
  },
  now: Date,
): VolumeProfileQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const rows = PROFILE_ROW_CHOICES[base.underlying];
  const rowPoints = parseChoice<number>(input.rowPoints, rows.choices, rows.fallback, "rowPoints");
  if (!rowPoints.ok) return rowPoints;

  const days = parseChoice<number>(input.days, COMPOSITE_DAY_CHOICES, 1, "days");
  if (!days.ok) return days;

  const edge = (raw: string | undefined, name: "from" | "to", fallback: number): number | string => {
    const text = raw?.trim();
    if (!text) return fallback;
    const minute = parseClockMinute(text);
    return minute === null ? `\`${name}\` must be a clock time, HH:MM (24-hour, IST).` : minute;
  };
  const from = edge(input.from, "from", FULL_SESSION_RANGE.fromMinute);
  const to = edge(input.to, "to", FULL_SESSION_RANGE.toMinute);
  if (typeof from === "string") return { ok: false, error: from };
  if (typeof to === "string") return { ok: false, error: to };
  const range = { fromMinute: from, toMinute: to };
  const problem = rangeProblem(range);
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: { underlying: base.underlying, date: base.date, rowPoints: rowPoints.value, range, days: days.value } };
}

interface CompositeSession {
  sessionDate: string;
  barsUsed: number;
  totalVolume: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** The session's own bars cover the window. */
  complete: boolean;
}

interface PreviousSession {
  sessionDate: string;
  symbol: string;
  poc: number;
  vah: number;
  val: number;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  complete: boolean;
}

function barsToProfile(bars: readonly FuturesBar[], rowPoints: number): {
  regular: FuturesBar[]; excluded: number; profile: SessionProfile | null;
} {
  const { regular, excluded } = selectRegularSessionBars(bars);
  return { regular, excluded, profile: buildSessionProfile(regular, rowPoints) };
}

/**
 * An ESTIMATED volume-by-price profile of one regular session of an index future, from stored 1-minute bars.
 *
 * Estimated, not observed: each bar's volume is spread evenly over the bar's high-low range (see
 * `session-volume-profile.ts`), and `sensitivity` says how much the result depends on that by rebuilding it from 5-minute
 * bars. The contract is the front month of the date, never a substitute: if its bars are not stored the route says so.
 */
export function registerVolumeProfileRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "futuresBarRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/volume-profile", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseVolumeProfileQuery(
        {
          underlying: queryString(request, "underlying"),
          date: queryString(request, "date"),
          rowPoints: queryString(request, "rowPoints"),
          from: queryString(request, "from"),
          to: queryString(request, "to"),
          days: queryString(request, "days"),
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, date: requestedDate, rowPoints, range, days } = parsed.value;
      const repository = dependencies.futuresBarRepository;
      const today = istDate(now);

      // The sessions on offer: each stored day, counted only under the contract that was front month on it.
      const sessions = await listStoredSessions(repository, underlying, today);

      const sessionDate = requestedDate ?? sessions[0]?.sessionDate ?? null;
      if (sessionDate === null) {
        response.status(200).json({
          data: {
            available: false,
            underlying,
            reason: `No futures bars with volume are stored for ${underlying} in the last ${SESSION_LOOKBACK_DAYS} days.`,
            availableSessions: sessions,
          },
        });
        return;
      }

      const contract = frontContractOn(underlying, sessionDate);
      if (!contract) {
        response.status(200).json({
          data: { available: false, underlying, sessionDate, reason: `No front-month ${underlying} future is known for ${sessionDate}.`, availableSessions: sessions },
        });
        return;
      }

      // The sessions the profile is built from: just the date, or the last `days` stored sessions of this same contract.
      const selection = days === 1
        ? { dates: [sessionDate], stoppedAtRoll: false }
        : chooseCompositeSessions(sessions, sessionDate, contract.symbol, days);
      const windowMinutes = range.toMinute - range.fromMinute;
      const perSession: CompositeSession[] = [];
      const allRangeBars: FuturesBar[] = [];
      let excluded = 0;
      let lastRegular: FuturesBar[] = [];
      for (const date of selection.dates) {
        // 09:00-16:00 IST: wide enough to see the pre-open and post-close bars, which are counted and set aside.
        const bars = await repository.bars({ symbol: contract.symbol, from: istInstant(date, 9), to: istInstant(date, 16) });
        const day = selectRegularSessionBars(bars);
        const dayBars = selectBarsInRange(day.regular, range);
        const dayProfile = buildSessionProfile(dayBars, rowPoints);
        const daySummary = summariseSession(dayBars);
        excluded += day.excluded;
        allRangeBars.push(...dayBars);
        lastRegular = day.regular;
        perSession.push({
          sessionDate: date,
          barsUsed: dayBars.length,
          totalVolume: dayProfile?.totalVolume ?? 0,
          poc: dayProfile?.poc ?? null,
          vah: dayProfile?.vah ?? null,
          val: dayProfile?.val ?? null,
          high: daySummary?.high ?? null,
          low: daySummary?.low ?? null,
          close: daySummary?.close ?? null,
          complete: assessBarQuality(dayBars, 0, windowMinutes).complete,
        });
      }
      const regular = lastRegular;
      const rangeBars = allRangeBars;
      const profile = buildSessionProfile(rangeBars, rowPoints);
      const rangeLabel = `${formatClockMinute(range.fromMinute)}-${formatClockMinute(range.toMinute)}`;
      if (profile === null) {
        response.status(200).json({
          data: {
            available: false,
            underlying,
            sessionDate,
            frontMonth: contract.symbol,
            reason: `No traded volume is stored for ${contract.symbol} on ${sessionDate} (${rangeLabel} IST). `
              + "The front month's bars are needed: the next month is a different, thinner market and is not used in its place.",
            availableSessions: sessions,
          },
        });
        return;
      }

      // The previous stored session, for reference levels, only for a single session (a composite already contains the
      // days before). It uses the same row height and its own front month.
      const later = sessions.findIndex((session) => session.sessionDate === sessionDate);
      const previousListing = days !== 1
        ? undefined
        : sessions.slice(later === -1 ? 0 : later + 1).find((session) => session.sessionDate < sessionDate);
      let previousSession: PreviousSession | null = null;
      if (previousListing) {
        const previousBars = await repository.bars({
          symbol: previousListing.symbol,
          from: istInstant(previousListing.sessionDate, 9),
          to: istInstant(previousListing.sessionDate, 16),
        });
        const previous = barsToProfile(previousBars, rowPoints);
        const summary = summariseSession(previous.regular);
        if (previous.profile && summary) {
          previousSession = {
            sessionDate: previousListing.sessionDate,
            symbol: previousListing.symbol,
            poc: previous.profile.poc,
            vah: previous.profile.vah,
            val: previous.profile.val,
            high: summary.high,
            low: summary.low,
            close: summary.close,
            totalVolume: previous.profile.totalVolume,
            complete: previousListing.complete,
          };
        }
      }

      const sessionStart = istInstant(sessionDate, 9, 15);
      const sessionEnd = istInstant(sessionDate, 15, 40);
      const inProgress = now.getTime() >= sessionStart.getTime() && now.getTime() < sessionEnd.getTime();
      // A session whose last bar can no longer arrive is history: it cannot change, so the browser may keep it.
      if (now.getTime() >= istInstant(sessionDate, 16).getTime()) response.set("Cache-Control", "private, max-age=600");

      response.status(200).json({
        data: {
          available: true,
          underlying,
          contract: {
            symbol: contract.symbol,
            providerSymbol: contract.providerInstrumentId,
            expiryDate: contract.expiryDate,
            lotSize: contract.lotSize,
          },
          sessionDate,
          sessionTimezone: "Asia/Kolkata",
          inProgress,
          rowPoints,
          rowPointsChoices: PROFILE_ROW_CHOICES[underlying].choices,
          estimated: true,
          volumeUnit: "units (contracts x lot size), as reported on the bar; not lots",
          // The last session's own regular-session summary (first and last bar); the window's is under `range`.
          session: summariseSession(regular),
          composite: {
            requestedDays: days,
            usedDays: selection.dates.length,
            dates: selection.dates,
            stoppedAtRoll: selection.stoppedAtRoll,
            perSession,
          },
          range: {
            fromMinute: range.fromMinute,
            toMinute: range.toMinute,
            fromLabel: formatClockMinute(range.fromMinute),
            toLabel: formatClockMinute(range.toMinute),
            isFullSession: isFullSession(range),
            stepMinutes: RANGE_STEP_MINUTES,
            minMinutes: MIN_RANGE_MINUTES,
            summary: summariseSession(rangeBars),
          },
          profile,
          // Quality is judged against the range's own length, so a window that has not finished yet reads as partial.
          quality: assessBarQuality(rangeBars, excluded, windowMinutes * selection.dates.length),
          sensitivity: profileSensitivity(rangeBars, profile),
          previousSession,
          closes: rangeBars.map((bar) => [bar.openTime.getTime(), bar.close]),
          availableSessions: sessions,
          definitions: SESSION_PROFILE_DEFINITIONS,
          source: "candles: Fyers 1-minute futures bars (cont_flag=0, raw per-contract)",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
