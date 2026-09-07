import type { Express } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { parseLimit, queryString } from "../../../../interfaces/http/common/query.js";
import { loadIndexDriverTape } from "../../../market-data/application/load-index-driver-tape.js";
import {
  resolveIndexDriverUniverse,
  SUPPORTED_DRIVER_INDEX_KEYS,
} from "../../../market-data/domain/nifty50-driver-weights.js";
import {
  MarketWatchBroadcaster,
  type MarketWatchTile,
} from "../../application/market-watch-broadcaster.js";
import { SharedStreamPollerRegistry } from "../../application/shared-stream-poller.js";

/**
 * Tiles, by the label the UI shows and the symbol the resolver understands.
 *
 * The Indian rows go through `resolveYahooSymbol`; the foreign indices are already
 * Yahoo-qualified and pass through it untouched. This used to be an inline map that
 * spelled Fin Nifty `FINNIFTY.NS` -- not a ticker -- so its quote rejected, the row was
 * dropped by the tile filter, and the panel rendered one tile short with nothing logged.
 * The resolver now owns every spelling in one place.
 */
const MARKET_WATCH_TILES: readonly MarketWatchTile[] = [
  { label: "NIFTY50", symbol: "NIFTY50" },
  { label: "BANKNIFTY", symbol: "BANKNIFTY" },
  { label: "FINNIFTY", symbol: "FINNIFTY" },
  { label: "SENSEX", symbol: "SENSEX" },
  { label: "HANG SENG", symbol: "^HSI" },
  { label: "NIKKEI 225", symbol: "^N225" },
  { label: "S&P 500", symbol: "^GSPC" },
];

export function registerStrategyRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies,
    "database" | "dashboardRepository" | "generateTradeIdeas" | "aiAutonomousAgent"
    | "marketQuoteClient" | "streamingQuoteClient"
  >,
): void {
  /*
   * One per app, so subscriber count does not scale provider traffic. See the class comment.
   *
   * Uses `streamingQuoteClient` -- the no-retry reader -- because the next tick is the retry. With
   * the retrying client a single rate-limited poll held this loop for ~30s, measured live.
   */
  const marketWatchBroadcaster = new MarketWatchBroadcaster({
    quotes: dependencies.streamingQuoteClient,
    tiles: MARKET_WATCH_TILES,
  });

  const liveAgentKey = (symbol: string, timeframe: string): string => `${symbol}|${timeframe}`;

  /*
   * Shared poller for /stream/live-agent, keyed by symbol+timeframe.
   *
   * Keyed rather than single because the route is parameterised: two tabs on NIFTY50 1d share one
   * poll, two tabs on different symbols do not, which is correct -- they need different data.
   *
   * 2500ms, up from the 1000ms this handler ran at per connection. Nothing downstream produces data
   * faster than 1m bars, so a per-second provider quote bought no freshness while making the browser
   * the single largest consumer of the quote budget.
   */
  const liveAgentPollers = new SharedStreamPollerRegistry<Record<string, unknown>>({
    name: "live-agent",
    intervalMs: 2_500,
    produce: async (key: string) => {
      const separator = key.indexOf("|");
      const symbol = key.slice(0, separator);
      const timeframe = key.slice(separator + 1);

      const candles = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 5);
      // Null means "nothing to publish yet", which is distinct from a failure: the registry neither
      // notifies nor caches, and the next tick tries again.
      if (candles.length < 2) return null;

      // The repository returns chart-ready chronological rows. The last row is therefore the newest
      // one; reading index zero served the oldest of the requested bars as "live" data.
      const latest = candles.at(-1)!;
      const previous = candles.at(-2)!;

      let livePrice = Number(latest.close);
      let previousClose = Number(previous.close);
      let change = livePrice - previousClose;
      let changePercent = previousClose === 0 ? 0 : (change / previousClose) * 100;
      let liveVolume = Number(latest.volume);
      let liveOpen = Number(latest.open);
      let liveHigh = Number(latest.high);
      let liveLow = Number(latest.low);
      let lastUpdated = latest.closeTime.toISOString();
      let priceSource = "STORED_CANDLE";

      // A provider failure must not be disguised as a synthetic market tick, so a null quote leaves
      // every field on the stored bar and says so through `priceSource`.
      const quote = await dependencies.streamingQuoteClient.quoteSymbol(symbol);
      if (quote !== null) {
        livePrice = quote.regularMarketPrice!;
        previousClose = quote.regularMarketPreviousClose ?? previousClose;
        change = quote.regularMarketChange ?? (livePrice - previousClose);
        changePercent = quote.regularMarketChangePercent
          ?? (previousClose === 0 ? 0 : (change / previousClose) * 100);
        liveVolume = quote.regularMarketVolume ?? liveVolume;
        liveOpen = quote.regularMarketOpen ?? liveOpen;
        liveHigh = quote.regularMarketDayHigh ?? liveHigh;
        liveLow = quote.regularMarketDayLow ?? liveLow;
        lastUpdated = quote.regularMarketTime?.toISOString() ?? lastUpdated;
        priceSource = quote.provider === "fyers-api-v3" ? "FYERS_QUOTE" : "YAHOO_QUOTE";
      }

      // This stream is read-only. The agent tick that used to run here now belongs to the scheduler
      // (`AI_AGENT_TICK` -> `run-agent-tick.ts`): it mutates paper trades, and a GET is exempt from
      // the mutation rate limiter, ran only while a tab was open, and blocked this payload behind
      // itself. See that file's header for the full reasoning.

      const rsi = latest.indicators?.["RSI"] as Record<string, unknown> | undefined;
      const sma = latest.indicators?.["SMA"] as Record<string, unknown> | undefined;
      const bollinger = latest.indicators?.["BOLLINGER_BANDS"] as Record<string, unknown> | undefined;
      const rsiValue = Number.isFinite(Number(rsi?.value)) ? Number(rsi?.value) : null;
      const smaValue = Number.isFinite(Number(sma?.value)) ? Number(sma?.value) : null;
      const bollingerValues = bollinger
        && Number.isFinite(Number(bollinger.upper))
        && Number.isFinite(Number(bollinger.middle))
        && Number.isFinite(Number(bollinger.lower))
        ? {
            upper: Number(bollinger.upper),
            middle: Number(bollinger.middle),
            lower: Number(bollinger.lower),
          }
        : null;

      return {
        symbol,
        livePrice,
        change,
        changePercent,
        open: liveOpen,
        high: liveHigh,
        low: liveLow,
        volume: liveVolume,
        lastUpdated,
        priceSource,
        indicators: {
          rsi: rsiValue,
          sma20: smaValue,
          bollinger: bollingerValues,
        },
        latestPattern: latest.patterns?.[0] || null,
        // Read from the journal, not this process's memory: the tick runs in the scheduler, so the
        // API's in-memory ring is always empty. Scoped to the watched symbol.
        thoughts: await dependencies.aiAutonomousAgent.listRecentThoughts(8, symbol),
        reflections: await dependencies.aiAutonomousAgent.getReflections(6),
      };
    },
  });

  app.get("/api/v1/trade-ideas", async (request, response, next) => {
    try {
      const limit = parseLimit(request) || 50;
      const date = queryString(request, "date");
      const strategy = queryString(request, "strategy");
      const includeExpiredText = queryString(request, "includeExpired");
      const includeExpired = includeExpiredText === "true" || includeExpiredText === "1";
      const ideas = await dependencies.dashboardRepository.listTradeIdeas(
        limit,
        date || undefined,
        strategy || undefined,
        includeExpired,
      );
      response.status(200).json({ data: ideas });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/trade-ideas/generate", async (request, response, next) => {
    try {
      const { symbol, timeframe } = request.body || {};
      if (!symbol || !timeframe) {
        response.status(400).json({ error: "symbol and timeframe are required." });
        return;
      }
      const instrumentResult = await dependencies.database.query(
        "SELECT id FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1",
        [String(symbol).toUpperCase()],
      );
      if (!instrumentResult.rows[0]) {
        response.status(404).json({ error: `Instrument ${symbol} not found.` });
        return;
      }
      const ideas = await dependencies.generateTradeIdeas.execute({
        instrumentId: instrumentResult.rows[0].id,
        timeframe: String(timeframe),
      });
      response.status(200).json({ data: ideas });
    } catch (error) {
      // Delegated rather than answered as 400. A generator that throws on a database outage
      // is not a malformed request, and `error.message` on the wire leaks connection strings
      // and driver internals to the browser.
      next(error);
    }
  });

  /**
   * `POST /api/v1/analysis/run` is deliberately gone.
   *
   * It read 100 candles, ignored them, and answered `"Analysis complete for <symbol>"`. No
   * indicator, pattern or idea was computed, and nothing in the dashboard called it -- so it
   * was a success response for work that never happened. Recalculating overlays on demand is
   * `analysis:calculate-indicators` / `analysis:detect-patterns`, both of which write their
   * results and record their algorithm version; the honest HTTP surface for that is a job,
   * not a synchronous route pretending to be one.
   */

  app.get("/api/v1/stream/live-agent", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    /*
     * Subscribes to the shared poller keyed by symbol+timeframe.
     *
     * This handler used to own a 1-second `setInterval` running three database queries and a provider
     * quote, *per connected tab* -- 60 provider requests a minute for one open dashboard, 240 for
     * four. Measured against roughly 20/min from the collectors, the browser was the dominant
     * consumer, and on 2026-08-27 it tripped the provider's edge rate limiter for forty minutes.
     * Tab count no longer affects upstream load, and the interval is 2.5s rather than 1s: nothing
     * downstream writes faster than 1m bars, so a per-second quote was finer than the data justifies.
     */
    const symbol = queryString(request, "symbol") || "NIFTY50";
    const timeframe = queryString(request, "timeframe") || "1d";

    const unsubscribe = liveAgentPollers.subscribe(
      liveAgentKey(symbol, timeframe),
      (payload) => {
        response.write(`data: ${JSON.stringify(payload)}

`);
      },
      (consecutiveFailures) => {
        // An SSE comment: keeps the connection provably alive for idle proxies and the client's
        // reconnect logic, and `EventSource` ignores comment lines, so the payload contract is
        // unchanged. Silence here is what made the original outage undiagnosable.
        response.write(`: live-agent-unavailable ${consecutiveFailures}

`);
      },
    );

    request.on("close", () => unsubscribe());
  });

  app.get("/api/v1/stream/market-watch", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    /*
     * Subscribes to the process-wide poller rather than starting its own.
     *
     * The interval used to live here, which meant one provider round-trip every 2.5s *per
     * connected tab* for identical data, all of it drawn from a quote budget shared with the
     * collectors and the agent. `MarketWatchBroadcaster` polls once for everyone and replays its
     * cached snapshot to each new subscriber immediately, so opening a second tab now costs
     * nothing and shows data at once instead of waiting a full interval.
     */
    const unsubscribe = marketWatchBroadcaster.subscribe(
      (rows) => {
        response.write(`data: ${JSON.stringify(rows)}\n\n`);
      },
      (consecutiveFailures) => {
        /*
         * An SSE comment, not a `data:` frame. It keeps the connection provably alive for idle
         * proxies and for the client's reconnect logic, and `EventSource` ignores comment lines, so
         * the payload contract is unchanged. `data: []` would be worse than silence: the panel would
         * render an empty market, a different claim from "quotes are unavailable", and the UI has no
         * way to tell them apart.
         */
        response.write(`: quote-unavailable ${consecutiveFailures}\n\n`);
      },
    );

    request.on("close", () => unsubscribe());
  });


  /**
   * Index contribution heatmap tiles + tape metrics (breadth / concentration).
   * Approximate weights × live Yahoo day% × index level → est. index points.
   * Soft-filters the autonomous agent; not an ML feature schema column.
   */
  app.get("/api/v1/index-drivers", async (request, response, next) => {
    try {
      const indexKey = String(
        (request.query as { index?: string }).index ?? "NIFTY50",
      );
      if (!resolveIndexDriverUniverse(indexKey)) {
        response.status(400).json({
          error: `Drivers heatmap supports: ${SUPPORTED_DRIVER_INDEX_KEYS.join(", ")}.`,
          supported: SUPPORTED_DRIVER_INDEX_KEYS,
        });
        return;
      }

      const tape = await loadIndexDriverTape(dependencies.marketQuoteClient, indexKey);
      if (!tape) {
        response.status(400).json({
          error: `Drivers heatmap supports: ${SUPPORTED_DRIVER_INDEX_KEYS.join(", ")}.`,
          supported: SUPPORTED_DRIVER_INDEX_KEYS,
        });
        return;
      }

      response.status(200).json({
        index: tape.index,
        label: tape.label,
        indexLevel: tape.indexLevel,
        indexDayPct: tape.indexDayPct,
        estNetPts: tape.estNetPts,
        asOf: tape.asOf,
        rosterCount: tape.rosterCount,
        tape: tape.tape,
        supported: SUPPORTED_DRIVER_INDEX_KEYS,
        disclaimer: tape.disclaimer,
        drivers: tape.drivers,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agent/performance", async (request, response, next) => {
    try {
      const metrics = await dependencies.aiAutonomousAgent.getPerformanceMetrics(
        queryString(request, "accountId") || "Default Paper Account",
        queryString(request, "period") || "1d",
      );
      response.status(200).json({ data: metrics });
    } catch (error) {
      next(error);
    }
  });
}
