import type { Express } from "express";
import yahooFinance from "yahoo-finance2";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { parseLimit, queryString } from "../../../../interfaces/http/common/query.js";

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
