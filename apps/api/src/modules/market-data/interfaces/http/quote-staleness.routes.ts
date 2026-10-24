import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { isNseHoliday } from "../../domain/nse-session-calendar.js";
import {
  QUOTE_STALENESS_DEFINITIONS,
  STALENESS_WINDOW,
  assessAge,
  contractStaleness,
  isMarketOpen,
} from "../../domain/quote-staleness.js";

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY", "SBIN", "RELIANCE"] as const;

export type QuoteStalenessQueryParse =
  | { ok: true; value: { underlying: string; expiry: string | null } }
  | { ok: false; error: string };

/** Validates `underlying` (one of the four collected, default NIFTY50) and the optional ISO `expiry`. Pure, so it is tested without a server. */
export function parseQuoteStalenessQuery(input: { underlying: string | undefined; expiry: string | undefined }): QuoteStalenessQueryParse {
  const underlying = (input.underlying || "NIFTY50").toUpperCase();
  if (!(UNDERLYINGS as readonly string[]).includes(underlying)) return { ok: false, error: `\`underlying\` must be one of ${UNDERLYINGS.join(", ")}.` };
  if (input.expiry !== undefined && input.expiry !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) {
    return { ok: false, error: "`expiry` must be an ISO date (YYYY-MM-DD)." };
  }
  return { ok: true, value: { underlying, expiry: input.expiry ? input.expiry : null } };
}

/**
 * How old the stored chain is and which contracts have stopped moving (see `quote-staleness.ts`): the age of the newest snapshot
 * judged against the collector's recent cadence, and for each contract how many of the newest snapshots repeat its bid and ask.
 * Observed from stored snapshots only; nothing here calls the broker.
 */
export function registerQuoteStalenessRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "optionChainRepository" | "database">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/option-chain/quote-staleness", async (request, response, next) => {
    try {
      const parsed = parseQuoteStalenessQuery({ underlying: queryString(request, "underlying"), expiry: queryString(request, "expiry") });
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const now = clock();
      const { underlying, expiry } = parsed.value;
      const stored = await dependencies.optionChainRepository.recentQuoteSnapshots({
        underlyingSymbol: underlying, expiryDate: expiry, asOf: now, count: STALENESS_WINDOW,
      });
      const holiday = await isNseHoliday(dependencies.database, now);
      const marketOpen = isMarketOpen(now, holiday.holiday);
      const times = stored.snapshots.map((snapshot) => snapshot.observedAt);
      response.status(200).json({
        data: {
          underlyingSymbol: underlying,
          expiryDate: stored.expiryDate,
          asOf: now.toISOString(),
          marketOpen,
          holiday: holiday.name,
          window: STALENESS_WINDOW,
          snapshotTimes: times.map((time) => time.toISOString()),
          age: assessAge(times, now, marketOpen),
          contracts: contractStaleness(stored.snapshots),
          definitions: QUOTE_STALENESS_DEFINITIONS,
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
