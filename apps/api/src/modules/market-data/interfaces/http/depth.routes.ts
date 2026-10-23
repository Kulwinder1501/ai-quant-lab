import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  buildDepthHeatmap,
  DEFAULT_HEATMAP_BUCKET_SECONDS,
  DEFAULT_HEATMAP_ROW_POINTS,
  HEATMAP_BUCKET_SECONDS,
  HEATMAP_DEFINITIONS,
  HEATMAP_ROW_POINTS,
  type HeatmapBucketSeconds,
  type HeatmapRowPoints,
} from "../../domain/depth-heatmap.js";
import {
  buildDepthHistory,
  DEFAULT_DEPTH_HISTORY_BUCKET_SECONDS,
  DEPTH_HISTORY_BUCKET_SECONDS,
  DEPTH_HISTORY_DEFINITIONS,
  SESSION_DAY_COUNT_CAP,
  sessionWindowUtc,
  type DepthHistoryBucketSeconds,
} from "../../domain/depth-history.js";
import { buildDepthLadder, IMBALANCE_DEFINITIONS, type StoredDepthFrame } from "../../domain/depth-ladder.js";
import { upcomingIndexFutures } from "../../domain/index-futures-contracts.js";

/** Index futures the app knows the contract of. Whether depth is stored for one is a separate question. */
const DEPTH_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;
export type DepthUnderlying = (typeof DEPTH_UNDERLYINGS)[number];

/** How far ahead of the server clock an `asOf` may be before it is refused as a mistake, not a past instant. */
const AS_OF_FUTURE_TOLERANCE_MS = 5_000;

export type DepthLadderQueryParse =
  | { ok: true; value: { underlying: DepthUnderlying; asOf: Date | null } }
  | { ok: false; error: string };

/**
 * Validates `underlying` and `asOf`. Pure, so the rules are tested without a server.
 *
 * `asOf` must be a full ISO-8601 instant with an offset (`2026-10-22T04:30:00Z`): a bare date would be read in
 * the server's timezone by `Date.parse`, the class of off-by-a-day error this codebase has hit before, so it
 * is refused rather than guessed at.
 */
export function parseDepthLadderQuery(
  input: { underlying: string | undefined; asOf: string | undefined },
  now: Date,
): DepthLadderQueryParse {
  const underlying = (input.underlying?.trim() || "BANKNIFTY").toUpperCase();
  if (!(DEPTH_UNDERLYINGS as readonly string[]).includes(underlying)) {
    return { ok: false, error: `\`underlying\` must be one of ${DEPTH_UNDERLYINGS.join(", ")}.` };
  }

  const rawAsOf = input.asOf?.trim();
  if (!rawAsOf) return { ok: true, value: { underlying: underlying as DepthUnderlying, asOf: null } };

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(rawAsOf)) {
    return { ok: false, error: "`asOf` must be an ISO-8601 instant with an offset, e.g. 2026-10-22T04:30:00Z." };
  }
  const asOf = new Date(rawAsOf);
  if (Number.isNaN(asOf.getTime())) {
    return { ok: false, error: "`asOf` is not a real date and time." };
  }
  if (asOf.getTime() > now.getTime() + AS_OF_FUTURE_TOLERANCE_MS) {
    return { ok: false, error: "`asOf` is in the future." };
  }
  return { ok: true, value: { underlying: underlying as DepthUnderlying, asOf } };
}

function istDate(instant: Date): string {
  return new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** How far back the session drop-down looks. The table starts in September 2026; older days are asked for by date. */
const SESSION_LOOKBACK_DAYS = 60;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export type DepthHistoryQueryParse =
  | { ok: true; value: { underlying: DepthUnderlying; date: string | null; bucketSeconds: DepthHistoryBucketSeconds } }
  | { ok: false; error: string };

/**
 * Validates `underlying`, `date` and `bucketSeconds`. Pure, so the rules are tested without a server.
 *
 * `date` is an IST calendar date (`2026-10-22`), the exchange's trading day. It is a date, not an instant, so the
 * "no bare date" rule of `asOf` does not apply: the route reads it in IST and says so. A date that is not a real
 * calendar day, or is after today in IST, is refused.
 */
function parseUnderlyingAndDate(
  input: { underlying: string | undefined; date: string | undefined },
  now: Date,
): { ok: true; underlying: DepthUnderlying; date: string | null } | { ok: false; error: string } {
  const underlying = (input.underlying?.trim() || "BANKNIFTY").toUpperCase();
  if (!(DEPTH_UNDERLYINGS as readonly string[]).includes(underlying)) {
    return { ok: false, error: `\`underlying\` must be one of ${DEPTH_UNDERLYINGS.join(", ")}.` };
  }
  const rawDate = input.date?.trim();
  if (!rawDate) return { ok: true, underlying: underlying as DepthUnderlying, date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || addDays(rawDate, 0) !== rawDate) {
    return { ok: false, error: "`date` must be a real calendar date, YYYY-MM-DD (IST trading day)." };
  }
  if (rawDate > istDate(now)) {
    return { ok: false, error: "`date` is in the future." };
  }
  return { ok: true, underlying: underlying as DepthUnderlying, date: rawDate };
}

/** A whole-number choice from a fixed list, or the default when absent. Text that merely starts with a number is refused. */
function parseChoice<T extends number>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const text = raw?.trim();
  if (!text) return { ok: true, value: fallback };
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !(allowed as readonly number[]).includes(parsed)) {
    return { ok: false, error: `\`${name}\` must be one of ${allowed.join(", ")}.` };
  }
  return { ok: true, value: parsed as T };
}

export function parseDepthHistoryQuery(
  input: { underlying: string | undefined; date: string | undefined; bucketSeconds: string | undefined },
  now: Date,
): DepthHistoryQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const bucket = parseChoice<DepthHistoryBucketSeconds>(
    input.bucketSeconds, DEPTH_HISTORY_BUCKET_SECONDS, DEFAULT_DEPTH_HISTORY_BUCKET_SECONDS, "bucketSeconds",
  );
  if (!bucket.ok) return bucket;
  return { ok: true, value: { underlying: base.underlying, date: base.date, bucketSeconds: bucket.value } };
}

export type DepthHeatmapQueryParse =
  | { ok: true; value: { underlying: DepthUnderlying; date: string | null; bucketSeconds: HeatmapBucketSeconds; rowPoints: HeatmapRowPoints } }
  | { ok: false; error: string };

/** Validates the heatmap's `underlying`, `date`, `bucketSeconds` (30, 60, 300) and `rowPoints` (1, 2, 5). */
export function parseDepthHeatmapQuery(
  input: { underlying: string | undefined; date: string | undefined; bucketSeconds: string | undefined; rowPoints: string | undefined },
  now: Date,
): DepthHeatmapQueryParse {
  const base = parseUnderlyingAndDate(input, now);
  if (!base.ok) return base;
  const bucket = parseChoice<HeatmapBucketSeconds>(
    input.bucketSeconds, HEATMAP_BUCKET_SECONDS, DEFAULT_HEATMAP_BUCKET_SECONDS, "bucketSeconds",
  );
  if (!bucket.ok) return bucket;
  const rows = parseChoice<HeatmapRowPoints>(input.rowPoints, HEATMAP_ROW_POINTS, DEFAULT_HEATMAP_ROW_POINTS, "rowPoints");
  if (!rows.ok) return rows;
  return { ok: true, value: { underlying: base.underlying, date: base.date, bucketSeconds: bucket.value, rowPoints: rows.value } };
}

interface SessionListing {
  sessionDate: string;
  providerSymbol: string;
  firstAt: string;
  lastAt: string;
  framesCapped: number;
  sparse: boolean;
}

type SessionDayRead =
  | { kind: "unavailable"; body: Record<string, unknown> }
  | {
    kind: "ok";
    sessionDate: string;
    providerSymbol: string;
    expiryDate: string | null;
    frames: StoredDepthFrame[];
    window: { from: Date; to: Date };
    /** The session's own day, 09:00 to 15:30 IST: the book is still being written. */
    inProgress: boolean;
    /** The 15:30 IST close has passed: the table can no longer add a frame to the window. */
    complete: boolean;
    availableSessions: SessionListing[];
  };

/**
 * Resolves and reads one IST trading day of stored frames: the session list for the drop-down, the day to read
 * (the one asked for, else the latest stored), the contract that was being collected, and its frames.
 */
async function readSessionDay(
  repository: HttpDependencies["depthFrameRepository"],
  query: { underlying: DepthUnderlying; date: string | null },
  now: Date,
): Promise<SessionDayRead> {
  const { underlying, date: requestedDate } = query;
  const today = istDate(now);

  // Every contract that was front or second month on any day of the look-back: the collector follows the
  // calendar, so a month's sessions can be on either side of a roll.
  const lookbackStart = addDays(today, -SESSION_LOOKBACK_DAYS);
  const expiryBySymbol = new Map<string, string>();
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset += 1) {
    for (const contract of upcomingIndexFutures(addDays(lookbackStart, offset), 2)) {
      if (contract.underlyingSymbol === underlying) expiryBySymbol.set(contract.providerInstrumentId, contract.expiryDate);
    }
  }

  const sessionsByDate = new Map<string, SessionListing>();
  for (const providerSymbol of expiryBySymbol.keys()) {
    const days = await repository.sessionDays({ providerSymbol, fromDate: lookbackStart, toDate: today });
    for (const day of days) {
      const existing = sessionsByDate.get(day.date);
      if (existing && existing.framesCapped >= day.framesCapped) continue;
      sessionsByDate.set(day.date, {
        sessionDate: day.date,
        providerSymbol,
        firstAt: day.firstAt.toISOString(),
        lastAt: day.lastAt.toISOString(),
        framesCapped: day.framesCapped,
        sparse: day.framesCapped < SESSION_DAY_COUNT_CAP,
      });
    }
  }
  const availableSessions = [...sessionsByDate.values()].sort((x, y) => y.sessionDate.localeCompare(x.sessionDate));

  const sessionDate = requestedDate ?? availableSessions[0]?.sessionDate ?? null;
  if (sessionDate === null) {
    return {
      kind: "unavailable",
      body: {
        available: false,
        underlying,
        reason: `No depth frames are stored for ${underlying} futures in the last ${SESSION_LOOKBACK_DAYS} days. `
          + "The depth collector captures one contract at a time, so an index it is not following has none.",
        availableSessions,
      },
    };
  }

  const window = sessionWindowUtc(sessionDate);
  const candidates = [
    sessionsByDate.get(sessionDate)?.providerSymbol,
    ...upcomingIndexFutures(sessionDate, 2)
      .filter((contract) => contract.underlyingSymbol === underlying)
      .map((contract) => contract.providerInstrumentId),
  ].filter((symbol, index, all): symbol is string => symbol !== undefined && all.indexOf(symbol) === index);

  for (const providerSymbol of candidates) {
    const frames = await repository.framesInWindow({ providerSymbol, ...window });
    if (frames.length === 0) continue;
    const expiryDate = expiryBySymbol.get(providerSymbol)
      ?? upcomingIndexFutures(sessionDate, 2).find((contract) => contract.providerInstrumentId === providerSymbol)?.expiryDate
      ?? null;
    return {
      kind: "ok",
      sessionDate,
      providerSymbol,
      expiryDate,
      frames,
      window,
      inProgress: now.getTime() >= window.from.getTime() && now.getTime() < window.to.getTime(),
      complete: now.getTime() >= window.to.getTime(),
      availableSessions,
    };
  }

  return {
    kind: "unavailable",
    body: {
      available: false,
      underlying,
      sessionDate,
      reason: `No depth frames are stored for ${underlying} futures on ${sessionDate} (09:00-15:30 IST). `
        + "Weekends and exchange holidays have none, and the collector follows one contract at a time.",
      contractsTried: candidates,
      availableSessions,
    },
  };
}

/**
 * The stored order book for an index future, as a ladder with its liquidity metrics.
 *
 * Observed (the frame is exactly what the feed delivered, stamped with our receive time) and derived (the
 * ladder, spread and imbalances, defined in `definitions`). Resting quantity, not executed volume. Only ten
 * levels are stored, so the response states how far they reach and how little of the book they hold: see
 * `ladder.coverage`. `status` says whether the book is live, stale, outside the session or a past instant,
 * so an old frame is never presented as current.
 */
export function registerDepthRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "depthFrameRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/depth/ladder", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseDepthLadderQuery(
        { underlying: queryString(request, "underlying"), asOf: queryString(request, "asOf") },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, asOf } = parsed.value;

      // Front month first, then the next: the collector follows the calendar, and on a roll the stored frames
      // can be on either side of it. Exact-symbol reads use the index; a prefix scan would not.
      const candidates = upcomingIndexFutures(istDate(asOf ?? now), 2)
        .filter((contract) => contract.underlyingSymbol === underlying);

      for (const contract of candidates) {
        const frame = await dependencies.depthFrameRepository.latestFrame({
          providerSymbol: contract.providerInstrumentId,
          ...(asOf ? { asOf } : {}),
        });
        if (frame === null) continue;

        response.status(200).json({
          data: {
            available: true,
            underlying,
            contract: {
              providerSymbol: contract.providerInstrumentId,
              expiryDate: contract.expiryDate,
              lotSize: contract.lotSize,
            },
            requestedAsOf: asOf ? asOf.toISOString() : null,
            ladder: buildDepthLadder(frame, { now, historical: asOf !== null }),
            definitions: IMBALANCE_DEFINITIONS,
            source: "depth_frames: stored feed frames, received-time stamped, top 10 of 50 levels",
          },
        });
        return;
      }

      response.status(200).json({
        data: {
          available: false,
          underlying,
          reason: `No depth frames are stored for ${underlying} futures`
            + `${asOf ? ` at or before ${asOf.toISOString()}` : ""}. The depth collector captures one contract at a `
            + "time (the Standard plan allows one tick-by-tick symbol), so an index it is not following has none.",
          contractsTried: candidates.map((contract) => contract.providerInstrumentId),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * One IST trading day of the stored book, as spread and imbalance over time.
   *
   * Observed frames summarised into buckets by the same rules as the ladder (see `buildDepthHistory`): nothing is
   * interpolated, a bucket with no usable frame has no value, and holes, concurrent writers and withheld frames are
   * reported rather than smoothed over. Top ten levels only: the imbalance describes the top of the book.
   */
  app.get("/api/v1/depth/history", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseDepthHistoryQuery(
        {
          underlying: queryString(request, "underlying"),
          date: queryString(request, "date"),
          bucketSeconds: queryString(request, "bucketSeconds"),
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, bucketSeconds } = parsed.value;

      const read = await readSessionDay(dependencies.depthFrameRepository, parsed.value, now);
      if (read.kind === "unavailable") {
        response.status(200).json({ data: read.body });
        return;
      }

      const history = buildDepthHistory(read.frames, { bucketSeconds });
      // A finished session is append-only history and cannot change, and reading one costs about two seconds, so
      // a repeat selection may be served from the browser. A session still being written is never cached.
      if (read.complete) response.set("Cache-Control", "private, max-age=600");
      response.status(200).json({
        data: {
          available: true,
          underlying,
          contract: { providerSymbol: read.providerSymbol, expiryDate: read.expiryDate },
          sessionDate: read.sessionDate,
          sessionTimezone: "Asia/Kolkata",
          window: { from: read.window.from.toISOString(), to: read.window.to.toISOString() },
          /** True from 09:00 to 15:30 IST on the session's own day: the book is still being written. */
          inProgress: read.inProgress,
          ...history,
          availableSessions: read.availableSessions,
          definitions: { ...DEPTH_HISTORY_DEFINITIONS, ...IMBALANCE_DEFINITIONS },
          source: "depth_frames: stored feed frames, received-time stamped, top 10 of 50 levels",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * One IST trading day of the stored book as a price-by-time grid of resting quantity (see `buildDepthHeatmap`).
   *
   * A price the stored levels did not reach is unknown, not zero, and is absent from `cells`; a covered price with
   * nothing resting is a real zero. Only the top ten levels a side are stored, so this is the top of the book.
   * `gaps`, `captureSessions` and `concurrentWriters` come from the same frames as the history so a hole or a doubled
   * stream is shown the same way on both.
   */
  app.get("/api/v1/depth/heatmap", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseDepthHeatmapQuery(
        {
          underlying: queryString(request, "underlying"),
          date: queryString(request, "date"),
          bucketSeconds: queryString(request, "bucketSeconds"),
          rowPoints: queryString(request, "rowPoints"),
        },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, bucketSeconds, rowPoints } = parsed.value;

      const read = await readSessionDay(dependencies.depthFrameRepository, parsed.value, now);
      if (read.kind === "unavailable") {
        response.status(200).json({ data: read.body });
        return;
      }

      const heatmap = buildDepthHeatmap(read.frames, { bucketSeconds, rowPoints });
      const { gaps, captureSessions, concurrentWriters } = buildDepthHistory(read.frames, { bucketSeconds: 60 });
      if (read.complete) response.set("Cache-Control", "private, max-age=600");
      response.status(200).json({
        data: {
          available: true,
          underlying,
          contract: { providerSymbol: read.providerSymbol, expiryDate: read.expiryDate },
          sessionDate: read.sessionDate,
          sessionTimezone: "Asia/Kolkata",
          window: { from: read.window.from.toISOString(), to: read.window.to.toISOString() },
          inProgress: read.inProgress,
          ...heatmap,
          gaps,
          captureSessions,
          concurrentWriters,
          availableSessions: read.availableSessions,
          definitions: HEATMAP_DEFINITIONS,
          source: "depth_frames: stored feed frames, received-time stamped, top 10 of 50 levels",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
