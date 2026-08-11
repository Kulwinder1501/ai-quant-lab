import type { Express } from "express";
import {
  quoteLabSymbol,
  quoteLabSymbols,
} from "../../../../infrastructure/market-data/yahoo-quote-client.js";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { parseLimit, queryString } from "../../../../interfaces/http/common/query.js";
import { loadIndexDriverTape } from "../../../market-data/application/load-index-driver-tape.js";
import {
  resolveIndexDriverUniverse,
  SUPPORTED_DRIVER_INDEX_KEYS,
} from "../../../market-data/domain/nifty50-driver-weights.js";

export function registerStrategyRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies,
    "database" | "dashboardRepository" | "generateTradeIdeas" | "aiAutonomousAgent"
  >,
): void {

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

    const symbol = queryString(request, "symbol") || "NIFTY50";
    const timeframe = queryString(request, "timeframe") || "1d";
    let pollInFlight = false;

    const intervalId = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const candles = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 5);
        if (candles.length < 2) return;
        // The repository returns chart-ready chronological rows. The last row is
        // therefore the newest one; reading index zero served the oldest of the
        // requested bars as "live" data.
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

        // A provider failure must not be disguised as a synthetic market tick, so a null
        // quote leaves every field on the stored bar and says so through `priceSource`.
        const quote = await quoteLabSymbol(symbol);
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
          priceSource = "YAHOO_QUOTE";
        }

        // This stream is read-only. The agent tick that used to run here now belongs to the
        // scheduler (`AI_AGENT_TICK` -> `run-agent-tick.ts`): it mutates paper trades, and a
        // GET is exempt from the mutation rate limiter, ran only while a tab was open, and
        // blocked this payload behind itself. See that file's header for the full reasoning.

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

        response.write(`data: ${JSON.stringify({
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
          // Read from the journal, not this process's memory: the tick runs in the scheduler, so
          // the API's in-memory ring is always empty. Scoped to the watched symbol.
          thoughts: await dependencies.aiAutonomousAgent.listRecentThoughts(8, symbol),
          reflections: await dependencies.aiAutonomousAgent.getReflections(6),
        })}\n\n`);
      } catch {
        // Transient stream failures are retried on the next interval.
      } finally {
        pollInFlight = false;
      }
    }, 1000);

    request.on("close", () => clearInterval(intervalId));
  });

  app.get("/api/v1/stream/market-watch", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    /**
     * Tiles, by the label the UI shows and the symbol the resolver understands.
     *
     * The Indian rows go through `resolveYahooSymbol`; the foreign indices are already
     * Yahoo-qualified and pass through it untouched. This used to be an inline map that
     * spelled Fin Nifty `FINNIFTY.NS` -- not a ticker -- so its quote rejected, the row was
     * dropped by the `.filter(Boolean)` below, and the panel rendered one tile short with
     * nothing logged. The resolver now owns every spelling in one place.
     */
    const tiles: ReadonlyArray<{ label: string; symbol: string }> = [
      { label: "NIFTY50", symbol: "NIFTY50" },
      { label: "BANKNIFTY", symbol: "BANKNIFTY" },
      { label: "FINNIFTY", symbol: "FINNIFTY" },
      { label: "SENSEX", symbol: "SENSEX" },
      { label: "HANG SENG", symbol: "^HSI" },
      { label: "NIKKEI 225", symbol: "^N225" },
      { label: "S&P 500", symbol: "^GSPC" },
    ];

    let pollInFlight = false;
    const intervalId = setInterval(async () => {
      // Without this a slow provider round-trip lets 2.5s ticks stack up on one connection.
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        // One batched request per tick rather than seven concurrent ones per connected tab.
        const quotes = await quoteLabSymbols(tiles.map((tile) => tile.symbol));
        const data = tiles.flatMap((tile) => {
          const quote = quotes.get(tile.symbol);
          if (quote === undefined) return [];
          return [{
            symbol: tile.label,
            price: quote.regularMarketPrice,
            changePercent: quote.regularMarketChangePercent,
            aiStance: "NEUT", // Kept for UI compatibility, could be dynamic later
          }];
        });

        response.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Transient stream failures are retried on the next interval.
      } finally {
        pollInFlight = false;
      }
    }, 2500);

    request.on("close", () => clearInterval(intervalId));
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

      const tape = await loadIndexDriverTape(indexKey);
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
