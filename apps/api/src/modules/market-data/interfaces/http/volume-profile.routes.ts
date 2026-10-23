import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { upcomingIndexFutures, type IndexFutureContract } from "../../domain/index-futures-contracts.js";
import {
  assessBarQuality,
  buildSessionProfile,
  COMPLETE_SESSION_MIN_BAR_SHARE,
  EXPECTED_SESSION_MINUTES,
  profileSensitivity,
  selectRegularSessionBars,
  SESSION_PROFILE_DEFINITIONS,
  summariseSession,
  type FuturesBar,
  type SessionProfile,
} from "../../domain/session-volume-profile.js";
import {
  addDays,
  istDate,
  parseChoice,
  parseUnderlyingAndDate,
  SESSION_LOOKBACK_DAYS,
  type IndexUnderlying,
} from "./session-query.js";

/** Row heights offered per index, in index points, with the default. Chosen so a typical session is 30-90 rows tall. */
export const PROFILE_ROW_CHOICES: Record<IndexUnderlying, { choices: readonly number[]; fallback: number }> = {
  BANKNIFTY: { choices: [5, 10, 20], fallback: 10 },
  NIFTY50: { choices: [2, 5, 10], fallback: 5 },
};

export type VolumeProfileQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; date: string | null; rowPoints: number } }
  | { ok: false; error: string };

/** Validates `underlying`, `date` and `rowPoints` (the choices depend on the index). Pure, so it is tested without a server. */
export function parseVolumeProfileQuery(
  input: { underlying: string | undefined; date: string | undefined; rowPoints: string | undefined },
  now: Date,
): VolumeProfileQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const rows = PROFILE_ROW_CHOICES[base.underlying];
  const rowPoints = parseChoice<number>(input.rowPoints, rows.choices, rows.fallback, "rowPoints");
  if (!rowPoints.ok) return rowPoints;
  return { ok: true, value: { underlying: base.underlying, date: base.date, rowPoints: rowPoints.value } };
}

const IST_OFFSET_MS = 330 * 60_000;

/** UTC instant of a wall-clock time on an IST calendar date. */
function istInstant(date: string, hour: number, minute = 0): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, hour, minute) - IST_OFFSET_MS);
}

/**
 * The contract that was the front month on a date, or undefined. Never the next month: that is a different, thinner
 * market, and a profile of it would pass for the day's volume.
 */
function frontContractOn(underlying: IndexUnderlying, date: string): IndexFutureContract | undefined {
  return upcomingIndexFutures(date, 1).find((contract) => contract.underlyingSymbol === underlying);
}

interface SessionListing {
  sessionDate: string;
  symbol: string;
  bars: number;
  barsWithVolume: number;
  firstAt: string;
  lastAt: string;
  /** Enough of the 375 regular minutes are present to treat the profile as the day's. */
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
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, date: requestedDate, rowPoints } = parsed.value;
      const repository = dependencies.futuresBarRepository;
      const today = istDate(now);

      // The sessions on offer: each stored day, counted only under the contract that was front month on it.
      const lookbackStart = addDays(today, -SESSION_LOOKBACK_DAYS);
      const frontSymbols = new Set<string>();
      for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset += 1) {
        const contract = frontContractOn(underlying, addDays(lookbackStart, offset));
        if (contract) frontSymbols.add(contract.symbol);
      }
      const sessions: SessionListing[] = [];
      for (const symbol of frontSymbols) {
        const days = await repository.sessionDays({ symbol, fromDate: lookbackStart, toDate: today });
        for (const day of days) {
          if (frontContractOn(underlying, day.date)?.symbol !== symbol || day.barsWithVolume === 0) continue;
          sessions.push({
            sessionDate: day.date,
            symbol,
            bars: day.bars,
            barsWithVolume: day.barsWithVolume,
            firstAt: day.firstAt.toISOString(),
            lastAt: day.lastAt.toISOString(),
            complete: day.bars >= EXPECTED_SESSION_MINUTES * COMPLETE_SESSION_MIN_BAR_SHARE,
          });
        }
      }
      sessions.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));

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

      // 09:00-16:00 IST: wide enough to see the pre-open and post-close bars, which are counted and set aside.
      const bars = await repository.bars({ symbol: contract.symbol, from: istInstant(sessionDate, 9), to: istInstant(sessionDate, 16) });
      const { regular, excluded, profile } = barsToProfile(bars, rowPoints);
      if (profile === null) {
        response.status(200).json({
          data: {
            available: false,
            underlying,
            sessionDate,
            frontMonth: contract.symbol,
            reason: `No traded volume is stored for ${contract.symbol} on ${sessionDate} (09:15-15:30 IST). `
              + "The front month's bars are needed: the next month is a different, thinner market and is not used in its place.",
            availableSessions: sessions,
          },
        });
        return;
      }

      // The previous stored session, for reference levels. It uses the same row height and its own front month.
      const later = sessions.findIndex((session) => session.sessionDate === sessionDate);
      const previousListing = sessions.slice(later === -1 ? 0 : later + 1).find((session) => session.sessionDate < sessionDate);
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
          session: summariseSession(regular),
          profile,
          quality: assessBarQuality(regular, excluded),
          sensitivity: profileSensitivity(regular, profile),
          previousSession,
          closes: regular.map((bar) => [bar.openTime.getTime(), bar.close]),
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
