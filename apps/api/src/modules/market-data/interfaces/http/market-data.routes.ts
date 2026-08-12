import type { Express, NextFunction, Response } from "express";
import { quoteLabSymbol } from "../../../../infrastructure/market-data/yahoo-quote-client.js";
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
  impliedVolatilitySkew,
} from "../../domain/option-chain.js";
import { priceEuropeanOption, yearsToExpiry } from "@ai-quant-lab/pricing";
import {
  effectiveSpotForForward,
  impliedForwardFromParity,
  impliedVolatilityFromPremium,
  midPriceForIv,
} from "@ai-quant-lab/pricing";

/** Same rate the option-buyer fill path uses, so premiums and IVs stay comparable. */
import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";
import { summariseIvPercentile, type DailyImpliedVolatility } from "../../domain/iv-percentile.js";

export function registerMarketDataRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies, "dashboardRepository" | "getInstitutionalContext" | "optionChainRepository" | "fyersLiveStreamer">,
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

      const smcCodes = ["FVG", "BOS", "CHOCH", "LIQUIDITY_SWEEP", "ORDER_BLOCK", "EQUILIBRIUM_ZONE"] as const;
      const indicators: Record<string, any[]> = {
        SMA: [], BB: [], RSI: [],
        ...Object.fromEntries(smcCodes.map((code) => [code, []])),
      };
      const patterns: any[] = [];
      rows.forEach((row) => {
        const timestamp = row.openTime instanceof Date ? row.openTime.toISOString() : String(row.openTime);
        const rowIndicators = row.indicators || {};
        if (rowIndicators["SMA"]) {
          const value = Number((rowIndicators["SMA"] as Record<string, unknown>).value);
          if (Number.isFinite(value)) indicators["SMA"]?.push({ timestamp, value });
        }
        if (rowIndicators["BOLLINGER_BANDS"]) {
          const values = rowIndicators["BOLLINGER_BANDS"] as Record<string, unknown>;
          const upper = Number(values.upper);
          const middle = Number(values.middle);
          const lower = Number(values.lower);
          if ([upper, middle, lower].every(Number.isFinite)) {
            indicators["BB"]?.push({ timestamp, upper, middle, lower });
          }
        }
        if (rowIndicators["RSI"]) {
          const value = Number((rowIndicators["RSI"] as Record<string, unknown>).value);
          if (Number.isFinite(value)) indicators["RSI"]?.push({ timestamp, value });
        }
        for (const code of smcCodes) {
          const values = rowIndicators[code];
          if (values && typeof values === "object" && !Array.isArray(values)) {
            indicators[code]?.push({ timestamp, ...(values as Record<string, unknown>) });
          }
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

      const quote = await quoteLabSymbol(symbol);
      if (quote === null) {
        throw new Error(`Live quote provider returned no valid price for ${symbol}.`);
      }
      const close = quote.regularMarketPrice!;
      const change = quote.regularMarketChange;
      const changePercent = quote.regularMarketChangePercent;

      let rsiValue: number | null = null;
      let smaValue: number | null = null;
      let bollinger: { upper: number; middle: number; lower: number } | null = null;
      let latestPattern: { name: string; direction: string; confidence: number } | null = null;
      try {
        const rows = await dependencies.dashboardRepository.listCandlesWithOverlays(symbol, timeframe, 1);
        if (rows.length > 0) {
          const latest = rows.at(-1)!;
          const indicators = latest.indicators || {};
          const rsi = indicators["RSI"] as Record<string, unknown> | undefined;
          const sma = indicators["SMA"] as Record<string, unknown> | undefined;
          const bands = indicators["BOLLINGER_BANDS"] as Record<string, unknown> | undefined;
          if (rsi && Number.isFinite(Number(rsi.value))) rsiValue = Number(rsi.value);
          if (sma && Number.isFinite(Number(sma.value))) smaValue = Number(sma.value);
          if (bands) {
            const upper = Number(bands.upper);
            const middle = Number(bands.middle);
            const lower = Number(bands.lower);
            if ([upper, middle, lower].every(Number.isFinite)) bollinger = { upper, middle, lower };
          }
          const patterns = Array.isArray(latest.patterns) ? latest.patterns : [];
          if (patterns.length > 0) {
            latestPattern = {
              name: patterns[0].name || patterns[0].code,
              direction: patterns[0].direction,
              confidence: Number(patterns[0].confidence),
            };
          }
        }
      } catch {
        // Provider quote still carries the response when overlay lookup fails.
      }

      response.status(200).json({
        data: {
          symbol,
          // Falls back to the symbol itself. The previous ternary answered "NIFTY 50" for
          // everything that was not BANKNIFTY, so `?symbol=RELIANCE` rendered a Reliance
          // quote labelled NIFTY 50 -- a wrong label on a right price.
          displayName: quote.shortName ?? symbol,
          exchange: quote.exchange ?? "NSE",
          livePrice: close,
          change,
          changePercent,
          open: Number.isFinite(Number(quote.regularMarketOpen)) ? Number(quote.regularMarketOpen) : null,
          high: Number.isFinite(Number(quote.regularMarketDayHigh)) ? Number(quote.regularMarketDayHigh) : null,
          low: Number.isFinite(Number(quote.regularMarketDayLow)) ? Number(quote.regularMarketDayLow) : null,
          volume: Number.isFinite(Number(quote.regularMarketVolume)) ? Number(quote.regularMarketVolume) : null,
          lastUpdated: quote.regularMarketTime ? quote.regularMarketTime.toISOString() : new Date().toISOString(),
          indicators: {
            rsi: rsiValue,
            sma20: smaValue,
            bollinger,
          },
          latestPattern,
          status: "MARKET_LIVE",
          researchOnly: true,
          priceSource: "YAHOO_QUOTE",
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

      /*
       * The forward the option market is pricing, per expiry, from put-call parity.
       *
       * Using spot with only a risk-free rate assumes a forward of S*e^(rT), which is
       * wrong for a dividend-paying index: the real forward sits below spot. Measured on
       * a live BANKNIFTY chain the error was 406 points, 0.7% of spot, and it surfaced as
       * a 7.5-point gap between call IV (9.00%) and put IV (16.52%) at the same strike —
       * something put-call parity forbids, so it was a modelling fault rather than a
       * market one. Deriving the forward removes the carry assumption entirely.
       *
       * Falls back to spot when parity cannot be evaluated, which keeps a chain with
       * one-sided quotes usable while leaving the same-strike IV gap visible rather than
       * papered over.
       */
      const forwardByExpiry = new Map<string, number>();
      for (const entry of expiriesOf(snapshot)) {
        const expiryKey = entry.expiryDate.toISOString().slice(0, 10);
        const timeToExpiry = yearsToExpiry(snapshot.observedAt, entry.expiryDate);
        if (timeToExpiry <= 0) continue;
        const midByStrike = new Map<number, { callMid?: number; putMid?: number }>();
        for (const quote of snapshot.quotes) {
          if (quote.expiryDate.toISOString().slice(0, 10) !== expiryKey) continue;
          const mid = midPriceForIv(quote.bid, quote.ask);
          if (mid === null) continue;
          const slot = midByStrike.get(quote.strikePrice) ?? {};
          if (quote.optionType === "CE") slot.callMid = mid;
          else slot.putMid = mid;
          midByStrike.set(quote.strikePrice, slot);
        }
        const pairs = [...midByStrike.entries()]
          .filter(([, slot]) => slot.callMid !== undefined && slot.putMid !== undefined)
          .map(([strike, slot]) => ({ strike, callMid: slot.callMid!, putMid: slot.putMid! }));
        const forward = impliedForwardFromParity(pairs, RISK_FREE_RATE, timeToExpiry);
        if (forward !== null) forwardByExpiry.set(expiryKey, forward);
      }
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
        // IV is solved from the MID of a two-sided quote, never from the last traded
        // price: a last price can be hours stale on an illiquid strike, and an IV derived
        // from it would look identical to one derived from a live market. A refusal
        // carries its reason so the UI can say why rather than showing a blank.
        const midForIv = midPriceForIv(quote.bid, quote.ask);
        const quoteExpiryKey = quote.expiryDate.toISOString().slice(0, 10);
        const quoteTime = yearsToExpiry(snapshot.observedAt, quote.expiryDate);
        const impliedForward = forwardByExpiry.get(quoteExpiryKey) ?? null;
        // The spot that makes the model's own forward equal the market's.
        const pricingSpot = impliedForward !== null && quoteTime > 0
          ? effectiveSpotForForward(impliedForward, RISK_FREE_RATE, quoteTime)
          : snapshot.underlyingValue;
        const ivResult = pricingSpot === null || midForIv === null
          ? null
          : impliedVolatilityFromPremium({
            spot: pricingSpot,
            strike: quote.strikePrice,
            timeToExpiryYears: quoteTime,
            riskFreeRate: RISK_FREE_RATE,
            optionType: quote.optionType,
            premium: midForIv,
          });
        // Greeks are computed AT the solved IV, so they inherit its refusals exactly.
        // Falling back to a house volatility would produce a full set of confident greeks
        // for a contract whose price could not support any of them -- the same failure the
        // IV solver refuses, one layer later and harder to spot.
        const greeks = ivResult?.measurable && pricingSpot !== null
          ? priceEuropeanOption({
            spot: pricingSpot,
            strike: quote.strikePrice,
            timeToExpiryYears: quoteTime,
            riskFreeRate: RISK_FREE_RATE,
            volatility: ivResult.impliedVolatility,
            optionType: quote.optionType,
          })
          : null;

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
          // Derived, and labelled as such: the volatility that would reproduce the
          // observed mid under Black-Scholes, not a figure the exchange published.
          impliedVolatility: ivResult?.measurable ? ivResult.impliedVolatility : null,
          impliedVolatilityRefusal: ivResult === null
            ? (snapshot.underlyingValue === null ? "NO_UNDERLYING" : "NO_TWO_SIDED_QUOTE")
            : ivResult.measurable ? null : ivResult.reason,
          // Null together with IV, never independently: a greek without the volatility it
          // was computed from is not a measurement.
          delta: greeks?.delta ?? null,
          gamma: greeks?.gamma ?? null,
          // Currency change per calendar day, and negative for a long option -- the buyer
          // pays theta. Presented as the engine reports it rather than sign-flipped.
          theta: greeks?.theta ?? null,
          // Per one absolute percentage point of IV, which is the convention a trader
          // reads; unlike delta it is positive for both calls and puts.
          vega: greeks?.vega ?? null,
          modelPremium: greeks?.premium ?? null,
          intrinsicValue: greeks?.intrinsicValue ?? null,
          timeValue: greeks?.timeValue ?? null,
          daysToExpiry: quoteTime > 0 ? quoteTime * 365 : 0,
        };
        row[quote.optionType === "CE" ? "call" : "put"] = leg;
      }

      // Averaged across the ATM call and put when both solve, because either alone carries the
      // skew of its own side.
      const meanIv = (values: readonly number[]): number | null =>
        values.length === 0 ? null : values.reduce((total, iv) => total + iv, 0) / values.length;

      const atmIv = atmStrike === null ? null : meanIv([...byStrike.values()]
        .filter((row) => row.strikePrice === atmStrike)
        .flatMap((row) => [row.call, row.put])
        .map((leg) => (leg as { impliedVolatility: number | null } | null)?.impliedVolatility ?? null)
        .filter((iv): iv is number => iv !== null));

      // One solve per stored day, from that day's last snapshot and its own spot, so a year of
      // history costs a few hundred inversions rather than every strike of every observation.
      const history: DailyImpliedVolatility[] = [];
      try {
        const dailyQuotes = await dependencies.optionChainRepository.dailyAtmQuotes({
          underlyingSymbol, days: 400,
        });
        const byDate = new Map<string, typeof dailyQuotes>();
        for (const quote of dailyQuotes) {
          byDate.set(quote.date, [...(byDate.get(quote.date) ?? []), quote]);
        }
        for (const [date, quotes] of byDate) {
          const daySpot = quotes.find((quote) => quote.underlyingValue !== null)?.underlyingValue ?? null;
          if (daySpot === null) continue;
          // That day's own ATM strike, not today's: spot moves, and ranking a fixed strike
          // across months would measure moneyness drift rather than volatility.
          const strikes = [...new Set(quotes.map((quote) => quote.strikePrice))];
          const dayAtm = strikes.reduce<number | null>((closest, strike) => (
            closest === null || Math.abs(strike - daySpot) < Math.abs(closest - daySpot)
              ? strike
              : closest
          ), null);
          if (dayAtm === null) continue;
          const solved = quotes
            .filter((quote) => quote.strikePrice === dayAtm)
            .map((quote) => {
              const mid = midPriceForIv(quote.bid, quote.ask);
              const time = yearsToExpiry(quote.observedAt, quote.expiryDate);
              if (mid === null || time <= 0) return null;
              const result = impliedVolatilityFromPremium({
                spot: daySpot, strike: quote.strikePrice, timeToExpiryYears: time,
                riskFreeRate: RISK_FREE_RATE, optionType: quote.optionType, premium: mid,
              });
              return result.measurable ? result.impliedVolatility : null;
            })
            .filter((iv): iv is number => iv !== null);
          const dayIv = meanIv(solved);
          if (dayIv !== null) history.push({ date, impliedVolatility: dayIv });
        }
      } catch {
        // History is an enrichment. Losing it must not cost the caller the live chain.
      }
      const ivPercentile = summariseIvPercentile({ history, currentImpliedVolatility: atmIv });

      response.status(200).json({
        data: {
          underlyingSymbol: snapshot.underlyingSymbol,
          available: true,
          provider: snapshot.provider,
          observedAt: snapshot.observedAt.toISOString(),
          underlyingValue: snapshot.underlyingValue,
          atmStrike,
          // Exposed so the carry assumption is auditable rather than hidden in the IV.
          impliedForwardByExpiry: Object.fromEntries(forwardByExpiry),
          expiries: expiriesOf(snapshot).map((entry) => ({
            expiryDate: entry.expiryDate.toISOString().slice(0, 10),
            expiryKind: entry.expiryKind,
          })),
          putCall: ratios,
          liquidity,
          // Named for what it is. A heavy-OI strike is where positions sit, not a level
          // price must respect, so it is never labelled support or resistance.
          largestOpenInterest: heaviest,
          impliedVolatilitySkew: snapshot.underlyingValue !== null
            ? impliedVolatilitySkew(snapshot.quotes, snapshot.underlyingValue, snapshot.observedAt, 0.02)
            : null,
          // The single IV a "is IV unusually high?" check reads. Averaged across the ATM
          // call and put when both solve, because either alone carries the skew of its
          // own side.
          atmImpliedVolatility: atmIv,
          /*
           * Where that IV sits against its own history -- factor 5 of the pre-trade checklist,
           * which had no answer at all before.
           *
           * Not measurable yet: chain history begins 2026-08-04 and cannot be backfilled, so
           * it refuses with a day count until enough distinct days exist. The refusal is the
           * point; a percentile over three days is arithmetically fine and worthless.
           */
          atmImpliedVolatilityPercentile: ivPercentile,
          strikes: [...byStrike.values()].sort(
            (left, right) => (left.strikePrice as number) - (right.strikePrice as number),
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/option-chain/stream", async (request, response, next) => {
    try {
      if (!dependencies.fyersLiveStreamer) {
        response.status(503).json({ error: "Live streaming is not configured." });
        return;
      }
      const underlyingSymbol = (queryString(request, "underlying") || "NIFTY50").toUpperCase();
      
      const snapshot = await dependencies.optionChainRepository.latestSnapshot({
        underlyingSymbol,
      });

      if (!snapshot || snapshot.quotes.length === 0) {
        response.status(404).json({ error: "No snapshot available to stream." });
        return;
      }

      // Collect symbols to subscribe to (strike calls and puts) + underlying spot if it has a symbol
      const symbolsToSubscribe = new Set<string>();
      for (const quote of snapshot.quotes) {
        if (quote.providerSymbol) {
          symbolsToSubscribe.add(quote.providerSymbol);
        }
      }
      
      // Underlying is usually available via Fyers symbol like NSE:NIFTY50-INDEX
      const fyersUnderlyingSymbol = snapshot.provider === "fyers-api-v3" && snapshot.quotes[0]?.providerSymbol 
          ? snapshot.quotes[0].providerSymbol.split(":")[0] + ":" + underlyingSymbol + "-INDEX"
          : null;
      if (fyersUnderlyingSymbol) symbolsToSubscribe.add(fyersUnderlyingSymbol);

      const symbolsArray = Array.from(symbolsToSubscribe);

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      // Ensure we are connected and subscribed
      dependencies.fyersLiveStreamer.subscribe(symbolsArray);

      const tickListener = (tick: any) => {
        // Only send ticks for the symbols we care about
        if (symbolsToSubscribe.has(tick.symbol)) {
          response.write(`data: ${JSON.stringify(tick)}\n\n`);
        }
      };

      dependencies.fyersLiveStreamer.on("tick", tickListener);

      request.on("close", () => {
        if (dependencies.fyersLiveStreamer) {
          dependencies.fyersLiveStreamer.off("tick", tickListener);
          // If we want to be clean, we can unsubscribe, but other clients might still need them.
          // For simplicity, we can just leave it subscribed or implement a reference counter in FyersLiveStreamer.
        }
      });
    } catch (error) {
      next(error);
    }
  });

}
