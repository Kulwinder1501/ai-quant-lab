import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  DEVELOPING_STEP_CHOICES,
  DEVELOPING_VALUE_DEFINITIONS,
  developingProfile,
} from "../../domain/developing-value.js";
import {
  assessBarQuality,
  buildSessionProfile,
  formatClockMinute,
  selectRegularSessionBars,
  summariseSession,
} from "../../domain/session-volume-profile.js";
import { frontContractOn, istInstant, listStoredSessions } from "./session-listing.js";
import { SESSION_LOOKBACK_DAYS, istDate, parseChoice, parseUnderlyingAndDate, type IndexUnderlying } from "./session-query.js";
import { PROFILE_ROW_CHOICES } from "./volume-profile.routes.js";

export type DevelopingQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; date: string | null; rowPoints: number; stepMinutes: number } }
  | { ok: false; error: string };

/** Validates `underlying`, `date`, `rowPoints` (the choices depend on the index) and `step` (minutes between checkpoints). */
export function parseDevelopingQuery(
  input: { underlying: string | undefined; date: string | undefined; rowPoints: string | undefined; step: string | undefined },
  now: Date,
): DevelopingQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const rows = PROFILE_ROW_CHOICES[base.underlying];
  const rowPoints = parseChoice<number>(input.rowPoints, rows.choices, rows.fallback, "rowPoints");
  if (!rowPoints.ok) return rowPoints;
  const step = parseChoice<number>(input.step, DEVELOPING_STEP_CHOICES, 30, "step");
  if (!step.ok) return step;
  return { ok: true, value: { underlying: base.underlying, date: base.date, rowPoints: rowPoints.value, stepMinutes: step.value } };
}

/**
 * How the POC and the value area of one session developed through the day, from stored 1-minute bars: the volume profile
 * rebuilt at each checkpoint. The same ESTIMATE as `/api/v1/volume-profile` (see `developing-value.ts`), front month of the
 * date only.
 */
export function registerDevelopingValueRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "futuresBarRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/volume-profile/developing", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseDevelopingQuery(
        {
          underlying: queryString(request, "underlying"),
          date: queryString(request, "date"),
          rowPoints: queryString(request, "rowPoints"),
          step: queryString(request, "step"),
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, date: requestedDate, rowPoints, stepMinutes } = parsed.value;
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

      const bars = await repository.bars({ symbol: contract.symbol, from: istInstant(sessionDate, 9), to: istInstant(sessionDate, 16) });
      const { regular, excluded } = selectRegularSessionBars(bars);
      const final = buildSessionProfile(regular, rowPoints);
      if (final === null) {
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

      const sessionStart = istInstant(sessionDate, 9, 15);
      const sessionEnd = istInstant(sessionDate, 15, 40);
      const inProgress = now.getTime() >= sessionStart.getTime() && now.getTime() < sessionEnd.getTime();
      if (now.getTime() >= istInstant(sessionDate, 16).getTime()) response.set("Cache-Control", "private, max-age=600");

      response.status(200).json({
        data: {
          available: true,
          underlying,
          contract: { symbol: contract.symbol, providerSymbol: contract.providerInstrumentId, expiryDate: contract.expiryDate, lotSize: contract.lotSize },
          sessionDate,
          sessionTimezone: "Asia/Kolkata",
          inProgress,
          rowPoints,
          rowPointsChoices: PROFILE_ROW_CHOICES[underlying].choices,
          stepMinutes,
          stepChoices: DEVELOPING_STEP_CHOICES,
          estimated: true,
          volumeUnit: "units (contracts x lot size), as reported on the bar; not lots",
          session: summariseSession(regular),
          quality: assessBarQuality(regular, excluded),
          points: developingProfile(regular, rowPoints, stepMinutes).map((point) => ({ at: formatClockMinute(point.atMinute), ...point })),
          closes: regular.map((bar) => [bar.openTime.getTime(), bar.close]),
          availableSessions: sessions,
          definitions: DEVELOPING_VALUE_DEFINITIONS,
          source: "candles: Fyers 1-minute futures bars (cont_flag=0, raw per-contract)",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
