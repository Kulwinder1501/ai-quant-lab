import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { buildDepthLadder, IMBALANCE_DEFINITIONS } from "../../domain/depth-ladder.js";
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
}
