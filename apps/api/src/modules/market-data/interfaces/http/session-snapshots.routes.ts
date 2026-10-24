import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { parseChoice } from "./session-query.js";

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY", "SBIN", "RELIANCE"] as const;
export const SESSION_SNAPSHOT_DAY_CHOICES = [5, 10, 20] as const;

export type SessionSnapshotsQueryParse =
  | { ok: true; value: { underlying: string; days: number } }
  | { ok: false; error: string };

/** Validates `underlying` (one of the four collected, default NIFTY50) and `days` (5, 10 or 20, default 10). Pure. */
export function parseSessionSnapshotsQuery(input: { underlying: string | undefined; days: string | undefined }): SessionSnapshotsQueryParse {
  const underlying = (input.underlying || "NIFTY50").toUpperCase();
  if (!(UNDERLYINGS as readonly string[]).includes(underlying)) return { ok: false, error: `\`underlying\` must be one of ${UNDERLYINGS.join(", ")}.` };
  const days = parseChoice<number>(input.days, SESSION_SNAPSHOT_DAY_CHOICES, 10, "days");
  if (!days.ok) return days;
  return { ok: true, value: { underlying, days: days.value } };
}

/**
 * The last in-session chain snapshot of each of the newest trading sessions, so a view can read the chain "as of" each one
 * (`/api/v1/option-chain?asOf=`) and compare sessions. Stored snapshots only; nothing here calls the broker.
 */
export function registerSessionSnapshotsRoutes(app: Express, dependencies: Pick<HttpDependencies, "optionChainRepository">): void {
  app.get("/api/v1/option-chain/session-snapshots", async (request, response, next) => {
    try {
      const parsed = parseSessionSnapshotsQuery({ underlying: queryString(request, "underlying"), days: queryString(request, "days") });
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, days } = parsed.value;
      const sessions = await dependencies.optionChainRepository.lastInSessionSnapshots({ underlyingSymbol: underlying, days });
      response.status(200).json({
        data: {
          underlyingSymbol: underlying,
          days,
          dayChoices: SESSION_SNAPSHOT_DAY_CHOICES,
          sessions: sessions.map((session) => ({ sessionDate: session.sessionDate, observedAt: session.observedAt.toISOString() })),
          definition: "The last chain snapshot of each trading session taken between 09:15 and 15:30 IST. The pre-open and post-close snapshots and listed exchange holidays are left out.",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
