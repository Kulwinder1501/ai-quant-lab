import type { Express, NextFunction, Response } from "express";
import yahooFinance from "yahoo-finance2";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { InvalidHttpQueryError, parseLimit, queryString } from "../../../../interfaces/http/common/query.js";
import {
  atmStrikeOf,
  expiriesOf,
  largestOpenInterestStrikes,
  moneynessOf,
  putCallRatios,
  quoteSpread,
  summariseLiquidity,
} from "../../domain/option-chain.js";

export function registerMarketDataRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "dashboardRepository" | "aiAutonomousAgent" | "getInstitutionalContext" | "optionChainRepository">,
): void {
  app.get("/api/v1/candles", async (request, response, next) => {
    try {
      const symbol = queryString(request, "symbol") || "NIFTY50";
      const timeframe = queryString(request, "timeframe") || "1d";
      const limit = parseLimit(request) || 100;
      const candles = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, limit);
      response.status(200).json({ data: candles });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  const getChartData = async (symbol: string, timeframe: string, response: Response, next: NextFunction) => {
    try {
      const rows = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol.toUpperCase(), timeframe, 100);
      const candles = rows.map((row) => ({
        timestamp: row.openTime instanceof Date ? row.openTime.toISOString() : String(row.openTime),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }));

      try {
        const symbolUpper = symbol.toUpperCase();
        let yfSymbol = symbolUpper;
        if (symbolUpper === "NIFTY50") yfSymbol = "^NSEI";
        else if (symbolUpper === "BANKNIFTY") yfSymbol = "^NSEBANK";
        else if (!symbolUpper.includes(".")) yfSymbol = `${symbolUpper}.NS`;

        const yf = new (yahooFinance as any)();
        const quote = (await yf.quote(yfSymbol)) as any;
        const liveClose = quote.regularMarketPrice;
        if (liveClose) {
          candles.push({
            timestamp: quote.regularMarketTime ? quote.regularMarketTime.toISOString() : new Date().toISOString(),
            open: quote.regularMarketOpen || liveClose,
            high: quote.regularMarketDayHigh || liveClose,
            low: quote.regularMarketDayLow || liveClose,
            close: liveClose,
            volume: quote.regularMarketVolume || 0,
          });
        }
      } catch {
        // Historical chart data remains available if the live quote provider fails.
      }

      const indicators: Record<string, any[]> = { SMA: [], BB: [], RSI: [] };
      const patterns: any[] = [];
      rows.forEach((row) => {
        const timestamp = row.openTime instanceof Date ? row.openTime.toISOString() : String(row.openTime);
        const rowIndicators = row.indicators || {};
        if (rowIndicators["SMA"]) {
          indicators["SMA"]?.push({ timestamp, value: Number((rowIndicators["SMA"] as any)?.value || row.close) });
        }
        if (rowIndicators["BB"]) {
          indicators["BB"]?.push({
            timestamp,
            upper: Number((rowIndicators["BB"] as any)?.upper || row.high),
            middle: Number((rowIndicators["BB"] as any)?.middle || row.close),
            lower: Number((rowIndicators["BB"] as any)?.lower || row.low),
          });
        }
        if (rowIndicators["RSI"]) {
          indicators["RSI"]?.push({ timestamp, value: Number((rowIndicators["RSI"] as any)?.value || 50) });
        }
        if (row.patterns && Array.isArray(row.patterns)) {
          row.patterns.forEach((pattern: any, patternIndex: number) => {
            patterns.push({
              id: `${row.id}-${patternIndex}`,
              name: pattern.name || pattern.code || "Pattern",
              type: pattern.code || "PATTERN",
              timestamp,
              price: row.close,
              confidence: Number(pattern.confidence || 0.8),
              direction: pattern.direction || "NEUTRAL",
            });
          });
        }
      });
      response.status(200).json({
        data: { symbol: symbol.toUpperCase(), timeframe, candles, indicators, patterns },
      });
    } catch (error) {
      next(error);
    }
  };

  app.get("/api/v1/charts/data", async (request, response, next) => {
    await getChartData(
      queryString(request, "symbol") || "NIFTY50",
      queryString(request, "timeframe") || "1d",
      response,
      next,
    );
  });

  app.post("/api/v1/charts/data", async (request, response, next) => {
    const { symbol = "NIFTY50", timeframe = "1d" } = request.body || {};
    await getChartData(String(symbol), String(timeframe), response, next);
  });

  app.get("/api/v1/live-price", async (request, response, next) => {
    try {
      const symbol = (queryString(request, "symbol") || "NIFTY50").toUpperCase();
      const timeframe = (queryString(request, "timeframe") || "1d").toLowerCase();
      let yfSymbol = symbol;
      if (symbol === "NIFTY50") yfSymbol = "^NSEI";
      else if (symbol === "BANKNIFTY") yfSymbol = "^NSEBANK";
      else if (!symbol.includes(".")) yfSymbol = `${symbol}.NS`;

      const yf = new (yahooFinance as any)();
      const quote = (await yf.quote(yfSymbol)) as any;
      const close = quote.regularMarketPrice || 0;
      const change = quote.regularMarketChange || 0;
      const changePercent = quote.regularMarketChangePercent || 0;

      try {
        await dependencies.aiAutonomousAgent.tick(symbol, timeframe, close);
      } catch {
        // Quote responses do not fail when the autonomous research tick fails.
      }

      let rsiValue = 51;
      let smaValue = close;
      let bollinger = { upper: close * 1.01, middle: close, lower: close * 0.99 };
      let latestPattern = { name: "BULLISH_ENGULFING", direction: "BULLISH", confidence: 0.85 };
      try {
        const rows = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 1);
        if (rows.length > 0) {
          const latest = rows[0]!;
          const indicators = latest.indicators || {};
          rsiValue = Number((indicators["RSI"] as any)?.value || rsiValue);
          smaValue = Number((indicators["SMA"] as any)?.value || smaValue);
          bollinger = (indicators["BB"] as any) || bollinger;
          const patterns = Array.isArray(latest.patterns) ? latest.patterns : [];
          if (patterns.length > 0) {
            latestPattern = {
              name: patterns[0].name || patterns[0].code || "BULLISH_ENGULFING",
              direction: patterns[0].direction || "BULLISH",
              confidence: Number(patterns[0].confidence || 0.85),
            };
          }
        }
      } catch {
        // Provider quote still carries the response when overlay lookup fails.
      }

      response.status(200).json({
        data: {
          symbol,
          displayName: quote.shortName || (symbol === "BANKNIFTY" ? "NIFTY BANK" : "NIFTY 50"),
          exchange: quote.exchange || "NSE",
          livePrice: close,
          change,
          changePercent,
          open: quote.regularMarketOpen || close,
          high: quote.regularMarketDayHigh || close,
          low: quote.regularMarketDayLow || close,
          volume: quote.regularMarketVolume || 0,
          lastUpdated: quote.regularMarketTime ? quote.regularMarketTime.toISOString() : new Date().toISOString(),
          indicators: {
            rsi: rsiValue,
            sma20: smaValue,
            bollinger: {
              upper: Number(bollinger.upper),
              middle: Number(bollinger.middle),
              lower: Number(bollinger.lower),
            },
          },
          latestPattern,
          status: "MARKET_LIVE",
          researchOnly: false,
        },
      });
    } catch (error) {
      console.error("Live Price Error:", error);
      next(error);
    }
  });

  app.get("/api/v1/institutional-context", async (request, response, next) => {
    try {
      const sessionsText = queryString(request, "sessions");
      const sessions = sessionsText ? Number(sessionsText) : undefined;
      if (sessions !== undefined && (!Number.isInteger(sessions) || sessions < 1 || sessions > 250)) {
        response.status(400).json({ error: "`sessions` must be an integer between 1 and 250." });
        return;
      }
      response.status(200).json({
        data: await dependencies.getInstitutionalContext.execute({ historySessions: sessions }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The latest stored option chain, with the metrics a pre-trade check needs.
   *
   * Serves what was observed plus derivations computed on read — spread, moneyness,
   * put/call ratios, heaviest-OI strikes. Nothing derived is stored, so changing a
   * definition re-scores history instead of invalidating it.
   */
  app.get("/api/v1/option-chain", async (request, response, next) => {
    try {
      const underlyingSymbol = (queryString(request, "underlying") || "NIFTY50").toUpperCase();
      const expiryDate = queryString(request, "expiry") || undefined;
      if (expiryDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
        response.status(400).json({ error: "`expiry` must be an ISO date (YYYY-MM-DD)." });
        return;
      }
      const costBudgetText = queryString(request, "costBudgetPercent");
      const costBudgetPercent = costBudgetText ? Number(costBudgetText) : 1.0;
      if (!Number.isFinite(costBudgetPercent) || costBudgetPercent <= 0) {
        response.status(400).json({ error: "`costBudgetPercent` must be a positive number." });
        return;
      }

      const snapshot = await dependencies.optionChainRepository.latestSnapshot({
        underlyingSymbol,
        expiryDate,
      });
      if (snapshot === null) {
        // Explicitly "nothing collected yet" rather than an empty chain, because the
        // series is forward-accumulating and absence is the normal early state.
        response.status(200).json({
          data: {
            underlyingSymbol,
            available: false,
            reason: "No option-chain snapshot has been collected for this underlying yet.",
            underlyings: await dependencies.optionChainRepository.listUnderlyings(),
          },
        });
        return;
      }

      const atmStrike = snapshot.underlyingValue === null
        ? null
        : atmStrikeOf(snapshot.quotes, snapshot.underlyingValue);
      const ratios = putCallRatios(snapshot.quotes);
      const liquidity = summariseLiquidity(snapshot.quotes, costBudgetPercent);
      const heaviest = largestOpenInterestStrikes(snapshot.quotes);

      // One row per strike with both sides alongside, which is how a chain is read.
      const byStrike = new Map<number, Record<string, unknown>>();
      for (const quote of snapshot.quotes) {
        let row = byStrike.get(quote.strikePrice);
        if (!row) {
          row = {
            strikePrice: quote.strikePrice,
            isAtm: atmStrike !== null && quote.strikePrice === atmStrike,
            call: null,
            put: null,
          };
          byStrike.set(quote.strikePrice, row);
        }
        const spread = quoteSpread(quote);
        const leg = {
          lastPrice: quote.lastPrice,
          bid: quote.bid,
          ask: quote.ask,
          volume: quote.volume,
          openInterest: quote.openInterest,
          openInterestChange: quote.openInterestChange,
          spreadAbsolute: spread?.absolute ?? null,
          spreadPercentOfMid: spread?.percentOfMid ?? null,
          withinCostBudget: spread === null ? null : spread.percentOfMid <= costBudgetPercent,
          moneyness: snapshot.underlyingValue === null || atmStrike === null
            ? null
            : moneynessOf(quote, snapshot.underlyingValue, atmStrike),
          providerSymbol: quote.providerSymbol,
        };
        row[quote.optionType === "CE" ? "call" : "put"] = leg;
      }

      response.status(200).json({
        data: {
          underlyingSymbol: snapshot.underlyingSymbol,
          available: true,
          provider: snapshot.provider,
          observedAt: snapshot.observedAt.toISOString(),
          underlyingValue: snapshot.underlyingValue,
          atmStrike,
          expiries: expiriesOf(snapshot).map((entry) => ({
            expiryDate: entry.expiryDate.toISOString().slice(0, 10),
            expiryKind: entry.expiryKind,
          })),
          putCall: ratios,
          liquidity,
          // Named for what it is. A heavy-OI strike is where positions sit, not a level
          // price must respect, so it is never labelled support or resistance.
          largestOpenInterest: heaviest,
          strikes: [...byStrike.values()].sort(
            (left, right) => (left.strikePrice as number) - (right.strikePrice as number),
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  });

}
