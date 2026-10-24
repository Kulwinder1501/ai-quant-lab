import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import {
  MOVE_WINDOW_CHOICES,
  REALIZED_MOVE_DEFINITIONS,
  buildSessionMoves,
  summariseMoves,
  type SessionInput,
} from "../../domain/realized-moves.js";
import { istInstant, listStoredSessions } from "./session-listing.js";
import { istDate, parseChoice, parseUnderlyingAndDate, type IndexUnderlying } from "./session-query.js";

export type RealizedMovesQueryParse =
  | { ok: true; value: { underlying: IndexUnderlying; window: number } }
  | { ok: false; error: string };

/** Validates `underlying` and `window` (how many finished sessions the averages cover). Pure, so it is tested without a server. */
export function parseRealizedMovesQuery(input: { underlying: string | undefined; window: string | undefined }, now: Date): RealizedMovesQueryParse {
  const base = parseUnderlyingAndDate({ underlying: input.underlying, date: undefined }, now);
  if (!base.ok) return base;
  const window = parseChoice<number>(input.window, MOVE_WINDOW_CHOICES, 10, "window");
  if (!window.ok) return window;
  return { ok: true, value: { underlying: base.underlying, window: window.value } };
}

/**
 * How far the index future actually moved in recent sessions, from stored 1-minute bars (see `realized-moves.ts`): each
 * session's range and close-to-close move, and the averages over the newest `window` finished sessions. Observed, the other
 * side of the comparison with what the option chain prices.
 */
export function registerRealizedMovesRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "futuresBarRepository">,
  options: { now?: () => Date } = {},
): void {
  const clock = options.now ?? (() => new Date());

  app.get("/api/v1/realized-moves", async (request, response, next) => {
    try {
      const now = clock();
      const parsed = parseRealizedMovesQuery({ underlying: queryString(request, "underlying"), window: queryString(request, "window") }, now);
      if (!parsed.ok) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const { underlying, window } = parsed.value;
      const repository = dependencies.futuresBarRepository;
      const today = istDate(now);

      // The newest sessions that have volume: `window` finished ones, the one before them (whose close the oldest move needs),
      // and today's if it is running.
      const listings = (await listStoredSessions(repository, underlying, today)).slice(0, window + 2);
      const sessionStart = istInstant(today, 9, 15);
      const sessionEnd = istInstant(today, 15, 40);
      const running = now.getTime() >= sessionStart.getTime() && now.getTime() < sessionEnd.getTime();

      const inputs: SessionInput[] = [];
      for (const listing of [...listings].reverse()) {
        const bars = await repository.bars({ symbol: listing.symbol, from: istInstant(listing.sessionDate, 9), to: istInstant(listing.sessionDate, 16) });
        inputs.push({ sessionDate: listing.sessionDate, symbol: listing.symbol, bars, inProgress: running && listing.sessionDate === today });
      }
      const moves = buildSessionMoves(inputs);
      const statistics = summariseMoves(moves, window);

      response.status(200).json({
        data: {
          available: moves.length > 0,
          underlying,
          asOf: now.toISOString(),
          window,
          windowChoices: MOVE_WINDOW_CHOICES,
          // Newest first, like the other session lists.
          sessions: [...moves].reverse(),
          statistics,
          reason: moves.length === 0 ? `No futures bars with volume are stored for ${underlying}.` : null,
          definitions: REALIZED_MOVE_DEFINITIONS,
          source: "candles: Fyers 1-minute futures bars (cont_flag=0, raw per-contract)",
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
