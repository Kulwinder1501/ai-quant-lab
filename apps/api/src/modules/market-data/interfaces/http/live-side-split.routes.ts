import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { isSideSplitWatchWindow } from "../../../../infrastructure/market-data/live-side-split-feed.js";
import { LIVE_SIDE_SPLIT_DEFINITIONS } from "../../domain/live-side-split.js";
import { frontContractOn } from "./session-listing.js";
import { istDate } from "./session-query.js";
import { parseVolumeProfileQuery } from "./volume-profile.routes.js";

/**
 * TODAY's volume at price split by the side of the quote the last price sat on, ESTIMATED live from this server's own
 * ticks and held in memory only. It exists for the front-month future of the day and has no history: a different date
 * is not a parameter, because there is nothing to answer it with. See `live-side-split.ts` for what the numbers are and
 * are not; the same wording is returned in `definitions` so the screen shows it.
 */
export function registerLiveSideSplitRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "liveSideSplit" | "fyersLiveStreamer">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/volume-profile/live-side-split", (request, response, next) => {
    try {
      const now = clock();
      // `date` is deliberately not read: only today exists.
      const parsed = parseVolumeProfileQuery(
        { underlying: queryString(request, "underlying"), date: undefined, rowPoints: queryString(request, "rowPoints") },
        now,
      );
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, rowPoints } = parsed.value;
      const sessionDate = istDate(now);
      const contract = frontContractOn(underlying, sessionDate);
      if (!contract) {
        response.status(200).json({
          data: { available: false, underlying, sessionDate, reason: `No front-month ${underlying} future is known for ${sessionDate}.`, definitions: LIVE_SIDE_SPLIT_DEFINITIONS },
        });
        return;
      }
      if (dependencies.fyersLiveStreamer === null) {
        response.status(200).json({
          data: { available: false, underlying, sessionDate, symbol: contract.symbol, reason: "This server has no live market feed configured.", definitions: LIVE_SIDE_SPLIT_DEFINITIONS },
        });
        return;
      }
      // Asking is what starts the count if the scheduled subscription has not yet (idempotent, one symbol). Only inside the
      // session window: a subscription made at night would open a Fyers socket for nobody, and with the day's token
      // expired it would retry in a loop.
      if (isSideSplitWatchWindow(now)) dependencies.fyersLiveStreamer.subscribe([contract.providerInstrumentId]);

      const snapshot = dependencies.liveSideSplit.snapshot(contract.providerInstrumentId, rowPoints, now.getTime());
      if (snapshot === null || snapshot.totals.total === 0) {
        response.status(200).json({
          data: {
            available: false,
            underlying,
            sessionDate,
            symbol: contract.symbol,
            reason: "No volume has been counted for this contract today yet. The count starts when this server first hears the contract during the 09:15-15:30 IST session, and is lost when the server restarts.",
            definitions: LIVE_SIDE_SPLIT_DEFINITIONS,
          },
        });
        return;
      }
      response.status(200).json({
        // The lab symbol (no exchange prefix), like every other volume-profile response; the snapshot holds the provider's.
        data: { available: true, underlying, sessionDate, estimated: true, ...snapshot, symbol: contract.symbol, definitions: LIVE_SIDE_SPLIT_DEFINITIONS },
      });
    } catch (error) {
      next(error);
    }
  });
}
