import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  COVERAGE_DAY_CHOICES,
  DATA_COVERAGE_DEFINITIONS,
  classifyDay,
  depthStatus,
  sourcesNotCollected,
  futuresStatus,
  snapshotStatus,
  typicalSnapshotMinutes,
  type CoverageDay,
  type DepthCoverage,
  type FuturesCoverage,
  type SnapshotCoverage,
} from "../../domain/data-coverage.js";
import { SESSION_DAY_COUNT_CAP as SESSION_DEPTH_CAP } from "../../domain/depth-history.js";
import { upcomingIndexFutures } from "../../domain/index-futures-contracts.js";
import { frontContractOn } from "./session-listing.js";
import { addDays, istDate, parseChoice, parseUnderlyingAndDate, type IndexUnderlying } from "./session-query.js";

export type CoverageQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; days: number } }
  | { ok: false; error: string };

/** Validates `underlying` and `days` (weekdays to look back). Pure, so it is tested without a server. */
export function parseCoverageQuery(input: { underlying: string | undefined; days: string | undefined }, now: Date): CoverageQueryParse {
  const base = parseUnderlyingAndDate({ underlying: input.underlying, date: undefined }, now);
  if (!base.ok) return base;
  const days = parseChoice<number>(input.days, COVERAGE_DAY_CHOICES, 20, "days");
  if (!days.ok) return days;
  return { ok: true, value: { underlying: base.underlying, days: days.value } };
}

/** The last `count` IST weekdays up to and including `today`, newest first. Exchange holidays are not known here. */
export function recentWeekdays(today: string, count: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; dates.length < count; offset += 1) {
    const date = addDays(today, -offset);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) dates.push(date);
  }
  return dates;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * What is stored for each recent session, per source: 1-minute futures bars, option-chain snapshots and depth frames. Counts and
 * times only (see `data-coverage.ts` for the status thresholds); the exchange holiday calendar is not stored, so a weekday with
 * nothing anywhere is reported as such and called a probable holiday, never as three failures.
 */
export function registerDataCoverageRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "futuresBarRepository" | "optionChainRepository" | "depthFrameRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/data-coverage", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseCoverageQuery({ underlying: queryString(request, "underlying"), days: queryString(request, "days") }, now);
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, days } = parsed.value;
      const today = istDate(now);
      const dates = recentWeekdays(today, days);
      const fromDate = dates[dates.length - 1]!;

      // Futures: the front month of each date, the contract every futures view reads.
      const frontSymbols = new Set<string>();
      for (const date of dates) {
        const contract = frontContractOn(underlying, date);
        if (contract) frontSymbols.add(contract.symbol);
      }
      const futuresByDate = new Map<string, { symbol: string; bars: number; barsWithVolume: number; firstAt: Date; lastAt: Date }>();
      for (const symbol of frontSymbols) {
        for (const day of await dependencies.futuresBarRepository.sessionDays({ symbol, fromDate, toDate: today })) {
          if (frontContractOn(underlying, day.date)?.symbol === symbol) futuresByDate.set(day.date, { symbol, ...day });
        }
      }

      // Depth: the collector follows the calendar, so a day's frames can be on the front or the second month.
      const depthSymbols = new Set<string>();
      for (const date of dates) {
        for (const contract of upcomingIndexFutures(date, 2)) {
          if (contract.underlyingSymbol === underlying) depthSymbols.add(contract.providerInstrumentId);
        }
      }
      const depthByDate = new Map<string, { symbol: string; framesCapped: number; firstAt: Date; lastAt: Date }>();
      for (const providerSymbol of depthSymbols) {
        for (const day of await dependencies.depthFrameRepository.sessionDays({ providerSymbol, fromDate, toDate: today })) {
          const held = depthByDate.get(day.date);
          if (!held || day.framesCapped > held.framesCapped) depthByDate.set(day.date, { symbol: providerSymbol, ...day });
        }
      }

      const snapshotRows = await dependencies.optionChainRepository.snapshotCoverageDays({ underlyingSymbol: underlying, fromDate, toDate: today });
      const snapshotByDate = new Map(snapshotRows.map((row) => [row.date, row]));

      const minuteNow = new Date(now.getTime() + 330 * 60_000);
      const clockMinute = minuteNow.getUTCHours() * 60 + minuteNow.getUTCMinutes();
      const sessionRunning = clockMinute >= 9 * 60 + 15 && clockMinute < 15 * 60 + 40;

      // The typical snapshot day is judged on finished days only: a session still running is short by construction.
      const typical = typicalSnapshotMinutes(
        dates.filter((date) => !(date === today && sessionRunning)).map((date) => snapshotByDate.get(date)?.inSessionMinutes ?? 0),
      );

      const unclassified = dates.map((date) => {
        const futuresRow = futuresByDate.get(date);
        const futures: FuturesCoverage = {
          symbol: futuresRow?.symbol ?? frontContractOn(underlying, date)?.symbol ?? null,
          bars: futuresRow?.bars ?? 0,
          barsWithVolume: futuresRow?.barsWithVolume ?? 0,
          firstAt: iso(futuresRow?.firstAt ?? null),
          lastAt: iso(futuresRow?.lastAt ?? null),
          status: futuresStatus(futuresRow?.bars ?? 0),
        };
        const snapshotRow = snapshotByDate.get(date);
        const snapshots: SnapshotCoverage = {
          inSessionMinutes: snapshotRow?.inSessionMinutes ?? 0,
          preOpenMinutes: snapshotRow?.preOpenMinutes ?? 0,
          postCloseMinutes: snapshotRow?.postCloseMinutes ?? 0,
          firstAt: iso(snapshotRow?.firstAt ?? null),
          lastAt: iso(snapshotRow?.lastAt ?? null),
          typicalMinutes: typical,
          status: snapshotStatus({
            inSessionMinutes: snapshotRow?.inSessionMinutes ?? 0,
            firstAt: snapshotRow?.firstAt ?? null,
            lastAt: snapshotRow?.lastAt ?? null,
            typicalMinutes: typical,
          }),
        };
        const depthRow = depthByDate.get(date);
        const capReached = (depthRow?.framesCapped ?? 0) >= SESSION_DEPTH_CAP;
        const depth: DepthCoverage = {
          symbol: depthRow?.symbol ?? null,
          framesCapped: depthRow?.framesCapped ?? 0,
          capReached,
          firstAt: iso(depthRow?.firstAt ?? null),
          lastAt: iso(depthRow?.lastAt ?? null),
          status: depthStatus({ framesCapped: depthRow?.framesCapped ?? 0, capReached, firstAt: depthRow?.firstAt ?? null, lastAt: depthRow?.lastAt ?? null }),
        };
        return { date, futures, snapshots, depth, inProgress: date === today && sessionRunning };
      });
      // A source with nothing anywhere in the window was not collected for this index: said once, and out of the gap logic.
      const notCollected = sourcesNotCollected(unclassified);
      const rows: CoverageDay[] = unclassified.map((day) => classifyDay(day, notCollected));

      // Freshness: when each source last wrote, whatever the hour.
      const latestFutures = rows.find((row) => row.futures.lastAt !== null)?.futures.lastAt ?? null;
      const frontToday = frontContractOn(underlying, today);
      const latestDepth = frontToday
        ? await dependencies.depthFrameRepository.latestFrame({ providerSymbol: frontToday.providerInstrumentId })
        : null;
      const latestSnapshotAt = await dependencies.optionChainRepository.latestObservedAt(underlying);

      const tally = (pick: (row: CoverageDay) => string) => rows.reduce(
        (counts, row) => ({ ...counts, [pick(row)]: (counts[pick(row)] ?? 0) + 1 }),
        {} as Record<string, number>,
      );
      response.status(200).json({
        data: {
          underlying,
          asOf: now.toISOString(),
          sessionTimezone: "Asia/Kolkata",
          days,
          dayChoices: COVERAGE_DAY_CHOICES,
          rows,
          sourcesNotCollected: notCollected,
          latest: {
            futuresBarAt: latestFutures,
            snapshotAt: iso(latestSnapshotAt),
            depthFrameAt: iso(latestDepth?.receivedAt ?? null),
          },
          summary: {
            futures: tally((row) => row.futures.status),
            snapshots: tally((row) => row.snapshots.status),
            depth: tally((row) => row.depth.status),
            probableHolidays: rows.filter((row) => row.probableHoliday).length,
            daysWithAGap: rows.filter((row) => row.gapInSource).length,
          },
          typicalSnapshotMinutes: typical,
          definitions: DATA_COVERAGE_DEFINITIONS,
          source: "candles (1m futures), option_chain_snapshots, depth_frames: counts and times only",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
