import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  chooseCompositeSessions,
  formatClockMinute,
  selectRegularSessionBars,
  summariseSession,
} from "../../domain/session-volume-profile.js";
import {
  BASELINE_DAY_CHOICES,
  BUCKET_MINUTE_CHOICES,
  VOLUME_BY_TIME_DEFINITIONS,
  bucketSessionVolume,
  compareWithBaseline,
  completeSessionTotal,
  median,
  type VolumeBucket,
} from "../../domain/volume-by-time.js";
import { frontContractOn, istInstant, listStoredSessions } from "./session-listing.js";
import {
  SESSION_LOOKBACK_DAYS,
  istDate,
  parseChoice,
  parseUnderlyingAndDate,
  type IndexUnderlying,
} from "./session-query.js";

export type VolumeByTimeQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; date: string | null; bucketMinutes: number; baselineDays: number } }
  | { ok: false; error: string };

/** Validates `underlying`, `date`, `bucket` (minutes) and `days` (baseline sessions). Pure, so it is tested without a server. */
export function parseVolumeByTimeQuery(
  input: { underlying: string | undefined; date: string | undefined; bucket: string | undefined; days: string | undefined },
  now: Date,
): VolumeByTimeQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const bucket = parseChoice<number>(input.bucket, BUCKET_MINUTE_CHOICES, 15, "bucket");
  if (!bucket.ok) return bucket;
  const days = parseChoice<number>(input.days, BASELINE_DAY_CHOICES, 10, "days");
  if (!days.ok) return days;
  return { ok: true, value: { underlying: base.underlying, date: base.date, bucketMinutes: bucket.value, baselineDays: days.value } };
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * How one session's traded volume was spread over the day, against the same time of day in previous sessions of the same
 * contract. Observed (the reported bar volume summed by clock bucket), with completeness stated per bucket: see
 * `volume-by-time.ts`. The contract is the front month of the date and the baseline never crosses a roll.
 */
export function registerVolumeByTimeRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "futuresBarRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/volume-by-time", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseVolumeByTimeQuery(
        {
          underlying: queryString(request, "underlying"),
          date: queryString(request, "date"),
          bucket: queryString(request, "bucket"),
          days: queryString(request, "days"),
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, date: requestedDate, bucketMinutes, baselineDays } = parsed.value;
      const repository = dependencies.futuresBarRepository;

      const sessions = await listStoredSessions(repository, underlying, istDate(now));
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

      // The day and the previous sessions of this same contract; a roll ends the baseline.
      const selection = chooseCompositeSessions(sessions, sessionDate, contract.symbol, baselineDays + 1);
      const bucketsOf = async (date: string) => {
        const bars = await repository.bars({ symbol: contract.symbol, from: istInstant(date, 9), to: istInstant(date, 16) });
        const { regular } = selectRegularSessionBars(bars);
        return { regular, buckets: bucketSessionVolume(regular, bucketMinutes) };
      };

      const today = await bucketsOf(sessionDate);
      if (!today.buckets.some((bucket) => bucket.volume !== null && bucket.volume > 0)) {
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

      const baselineDates = selection.dates.filter((date) => date !== sessionDate);
      const baseline: Array<{ date: string; buckets: VolumeBucket[] }> = [];
      for (const date of baselineDates) baseline.push({ date, buckets: (await bucketsOf(date)).buckets });

      const comparison = compareWithBaseline(today.buckets, baseline.map((session) => session.buckets));
      const baselineTotals = baseline.map((session) => ({ sessionDate: session.date, total: completeSessionTotal(session.buckets), complete: session.buckets.every((bucket) => bucket.complete) }));
      const completeTotals = baselineTotals.map((entry) => entry.total).filter((total): total is number => total !== null);
      const todayTotal = completeSessionTotal(today.buckets);
      const todayVolumeSoFar = today.buckets.reduce((sum, bucket) => sum + (bucket.volume ?? 0), 0);
      const baselineMedianDayTotal = median(completeTotals);

      const sessionStart = istInstant(sessionDate, 9, 15);
      const sessionEnd = istInstant(sessionDate, 15, 40);
      const inProgress = now.getTime() >= sessionStart.getTime() && now.getTime() < sessionEnd.getTime();
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
            daysToExpiry: calendarDaysBetween(sessionDate, contract.expiryDate),
          },
          sessionDate,
          sessionTimezone: "Asia/Kolkata",
          inProgress,
          bucketMinutes,
          bucketMinuteChoices: BUCKET_MINUTE_CHOICES,
          baselineDayChoices: BASELINE_DAY_CHOICES,
          observed: true,
          volumeUnit: "units (contracts x lot size), as reported on the bar; not lots",
          baseline: {
            requestedSessions: baselineDays,
            sessions: baselineDates.length,
            dates: baselineDates,
            stoppedAtRoll: selection.stoppedAtRoll,
            perSession: baselineTotals,
          },
          session: summariseSession(today.regular),
          buckets: comparison.map((bucket) => ({
            from: formatClockMinute(bucket.startMinute),
            to: formatClockMinute(bucket.endMinute),
            ...bucket,
          })),
          day: {
            /** The day's total only when every bucket is complete; otherwise `volumeSoFar` is a lower bound. */
            total: todayTotal,
            volumeSoFar: todayVolumeSoFar,
            complete: todayTotal !== null,
            baselineMedianTotal: baselineMedianDayTotal,
            baselineSessionsWithTotal: completeTotals.length,
            relative: todayTotal !== null && baselineMedianDayTotal !== null && baselineMedianDayTotal > 0 ? todayTotal / baselineMedianDayTotal : null,
          },
          availableSessions: sessions,
          definitions: VOLUME_BY_TIME_DEFINITIONS,
          source: "candles: Fyers 1-minute futures bars (cont_flag=0, raw per-contract)",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
