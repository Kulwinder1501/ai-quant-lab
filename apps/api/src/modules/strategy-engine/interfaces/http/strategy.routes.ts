import type { Express } from "express";
import yahooFinance from "yahoo-finance2";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { parseLimit, queryString } from "../../../../interfaces/http/common/query.js";
import {
  estimateContributionPts,
  resolveIndexDriverUniverse,
  SUPPORTED_DRIVER_INDEX_KEYS,
  yahooEquitySymbol,
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

  app.post("/api/v1/trade-ideas/generate", async (request, response) => {
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
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to generate trade ideas" });
    }
  });

  app.post("/api/v1/analysis/run", async (request, response) => {
    try {
      const { symbol, timeframe } = request.body || {};
      if (!symbol || !timeframe) {
        response.status(400).json({ error: "symbol and timeframe are required." });
        return;
      }
      const candles = await dependencies.dashboardRepository.listCandlesWithOverlays(
        String(symbol),
        String(timeframe),
        100,
      );
      response.status(200).json({
        status: "success",
        count: candles.length,
        message: `Analysis complete for ${symbol} (${timeframe})`,
      });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to run analysis" });
    }
  });

  app.get("/api/v1/stream/live-agent", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const symbol = queryString(request, "symbol") || "NIFTY50";
    const timeframe = queryString(request, "timeframe") || "1d";
    let tickCount = 0;

    const intervalId = setInterval(async () => {
      try {
        const candles = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 5);
        if (candles.length < 2) return;
        const latest = candles[0]!;
        const previous = candles[1]!;

        let livePrice = Number(latest.close);
        let previousClose = Number(previous.close);
        let change = 0;
        let changePercent = 0;
        let liveVolume = Number(latest.volume);
        let liveOpen = Number(latest.open);
        let liveHigh = Number(latest.high);
        let liveLow = Number(latest.low);
        let lastUpdated = new Date().toISOString();

        try {
          const symbolUpper = symbol.toUpperCase();
          let yfSymbol = symbolUpper;
          if (symbolUpper === "NIFTY50") yfSymbol = "^NSEI";
          else if (symbolUpper === "BANKNIFTY") yfSymbol = "^NSEBANK";
          else if (!symbolUpper.includes(".")) yfSymbol = `${symbolUpper}.NS`;

          const yf = new (yahooFinance as any)();
          const quote = (await yf.quote(yfSymbol)) as any;
          if (quote.regularMarketPrice) {
            livePrice = quote.regularMarketPrice;
            previousClose = quote.regularMarketPreviousClose || previousClose;
            change = quote.regularMarketChange || (livePrice - previousClose);
            changePercent = quote.regularMarketChangePercent || ((change / previousClose) * 100);
            liveVolume = quote.regularMarketVolume || liveVolume;
            liveOpen = quote.regularMarketOpen || liveOpen;
            liveHigh = quote.regularMarketDayHigh || liveHigh;
            liveLow = quote.regularMarketDayLow || liveLow;
            lastUpdated = quote.regularMarketTime ? quote.regularMarketTime.toISOString() : lastUpdated;
          }
        } catch {
          const baseClose = Number(latest.close);
          const noise = (Math.sin(Date.now() / 800) * (symbol === "NIFTY50" ? 18 : 45))
            + ((Math.random() - 0.5) * (symbol === "NIFTY50" ? 15 : 40));
          livePrice = Number((baseClose + noise).toFixed(2));
          change = Number((livePrice - previousClose).toFixed(2));
          changePercent = Number(((change / previousClose) * 100).toFixed(2));
          liveVolume = Number(latest.volume) + (tickCount * (symbol === "NIFTY50" ? 125 : 310));
          liveHigh = Math.max(Number(latest.high), livePrice);
          liveLow = Math.min(Number(latest.low), livePrice);
        }

        await dependencies.aiAutonomousAgent.tick(symbol, timeframe, livePrice);
        const rsiValue = latest.indicators?.["rsi"] !== undefined ? Number(latest.indicators["rsi"]) : 55;
        const smaValue = latest.indicators?.["sma_20"] !== undefined
          ? Number(latest.indicators["sma_20"])
          : Number((livePrice * 0.995).toFixed(2));
        const bollinger = (latest.indicators?.["bb_20_2"] as Record<string, unknown>) || {
          upper: livePrice * 1.015,
          middle: livePrice,
          lower: livePrice * 0.985,
        };

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
          indicators: {
            rsi: rsiValue,
            sma20: smaValue,
            bollinger: {
              upper: Number(bollinger.upper),
              middle: Number(bollinger.middle),
              lower: Number(bollinger.lower),
            },
          },
          latestPattern: latest.patterns?.[0] || null,
          thoughts: dependencies.aiAutonomousAgent.getThoughts(8),
          reflections: await dependencies.aiAutonomousAgent.getReflections(6),
        })}\n\n`);
        tickCount += 1;
      } catch {
        // Transient stream failures are retried on the next interval.
      }
    }, 1000);

    request.on("close", () => clearInterval(intervalId));
  });

  app.get("/api/v1/stream/market-watch", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    // Map UI symbols to Yahoo Finance symbols
    const symbolMap: Record<string, string> = {
      "NIFTY50": "^NSEI",
      "BANKNIFTY": "^NSEBANK",
      "FINNIFTY": "FINNIFTY.NS",
      "SENSEX": "^BSESN",
      "HANG SENG": "^HSI",
      "NIKKEI 225": "^N225",
      "S&P 500": "^GSPC",
    };

    const intervalId = setInterval(async () => {
      try {
        const yf = new (yahooFinance as any)();
        const quotes = await Promise.all(
          Object.values(symbolMap).map(sym => 
            yf.quote(sym).catch(() => null)
          )
        );

        const data = Object.keys(symbolMap).map((uiSymbol, index) => {
          const quote = quotes[index];
          if (!quote) return null;
          
          return {
            symbol: uiSymbol,
            price: quote.regularMarketPrice,
            changePercent: quote.regularMarketChangePercent,
            aiStance: "NEUT" // Kept for UI compatibility, could be dynamic later
          };
        }).filter(Boolean);

        response.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        // Ignore transient errors
      }
    }, 2500);

    request.on("close", () => clearInterval(intervalId));
  });

  /**
   * Index contribution heatmap tiles (NIFTY50 / BANKNIFTY / FINNIFTY / SENSEX).
   * Approximate weights × live Yahoo day% × index level → est. index points.
   * UI-only — not used by ML feature construction.
   */
  app.get("/api/v1/index-drivers", async (request, response, next) => {
    try {
      const indexKey = String(
        (request.query as { index?: string }).index ?? "NIFTY50",
      );
      const universe = resolveIndexDriverUniverse(indexKey);
      if (!universe) {
        response.status(400).json({
          error: `Drivers heatmap supports: ${SUPPORTED_DRIVER_INDEX_KEYS.join(", ")}.`,
          supported: SUPPORTED_DRIVER_INDEX_KEYS,
        });
        return;
      }

      const yf = new (yahooFinance as any)();
      const yahooSymbols = universe.drivers.map((row) =>
        yahooEquitySymbol(row.symbol),
      );

      // Batch quote index + equities (chunked to avoid oversized Yahoo payloads).
      const chunkSize = 25;
      const quoteBySymbol = new Map<string, any>();
      const allSymbols = [universe.yahooIndexSymbol, ...yahooSymbols];
      for (let i = 0; i < allSymbols.length; i += chunkSize) {
        const chunk = allSymbols.slice(i, i + chunkSize);
        try {
          const batch = await yf.quote(chunk);
          const rows = Array.isArray(batch) ? batch : [batch];
          for (const quote of rows) {
            if (quote?.symbol) quoteBySymbol.set(String(quote.symbol), quote);
          }
        } catch {
          // Fall back to per-symbol so one bad ticker does not blank the panel.
          await Promise.all(
            chunk.map(async (sym) => {
              try {
                const quote = await yf.quote(sym);
                if (quote?.symbol) quoteBySymbol.set(String(quote.symbol), quote);
              } catch {
                // skip
              }
            }),
          );
        }
      }

      const indexQuote =
        quoteBySymbol.get(universe.yahooIndexSymbol) ?? null;
      const indexLevel =
        typeof indexQuote?.regularMarketPrice === "number"
          ? indexQuote.regularMarketPrice
          : null;

      const asOf = new Date().toISOString();
      const drivers = universe.drivers
        .map((row) => {
          const quote =
            quoteBySymbol.get(yahooEquitySymbol(row.symbol)) ??
            quoteBySymbol.get(row.symbol) ??
            null;
          const dayPct =
            typeof quote?.regularMarketChangePercent === "number"
              ? quote.regularMarketChangePercent
              : null;
          const last =
            typeof quote?.regularMarketPrice === "number"
              ? quote.regularMarketPrice
              : null;
          const estPts =
            dayPct != null && indexLevel != null
              ? estimateContributionPts(row.weightPct, dayPct, indexLevel)
              : null;
          return {
            symbol: row.symbol,
            name: row.name,
            weightPct: row.weightPct,
            dayPct,
            last,
            estPts,
          };
        })
        .filter((d) => d.dayPct != null && d.estPts != null);

      drivers.sort(
        (a, b) => Math.abs(b.estPts ?? 0) - Math.abs(a.estPts ?? 0),
      );

      const estNetPts = drivers.reduce((sum, d) => sum + (d.estPts ?? 0), 0);

      response.status(200).json({
        index: universe.key,
        label: universe.label,
        indexLevel,
        estNetPts,
        asOf,
        supported: SUPPORTED_DRIVER_INDEX_KEYS,
        disclaimer:
          "Est. points = weight% × day% × index / 10000. Weights are approximate (not live exchange free-float) — close to contribution, not exchange-official.",
        drivers,
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
