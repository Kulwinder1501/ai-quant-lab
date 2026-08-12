import type { Express, Request } from "express";
import { quoteLabSymbols } from "../../../../infrastructure/market-data/yahoo-quote-client.js";
import { respondToRouteError } from "../../../../interfaces/http/common/route-errors.js";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import {
  InvalidHttpQueryError,
  parseLimit,
  parseUtcTimestamp,
  queryString,
} from "../../../../interfaces/http/common/query.js";
import { InvalidTradeHistoryQueryError } from "../../application/list-paper-trade-history.js";
import { calculateEntryFees } from "../../domain/brokerage-calculator.js";
import type { TradeOutcomeFilter } from "../../domain/paper-trade-history.js";
import type { PaperTradeExitReason, PaperTradeStatus } from "../../domain/paper-trading.js";
import { lotsToQuantity, validateQuantity } from "../../domain/lot-size-validator.js";
import { resolveOptionExpiryInstant } from "../../domain/option-buyer-fill.js";
import { PrepareOptionEntry } from "../../application/prepare-option-entry.js";
import { isOptionBuyerTrade } from "../../domain/option-mark-to-market.js";
import {
  hasAnyOptionContractField,
  valuePaperTrade,
} from "../../domain/paper-trade-live-valuation.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../infrastructure/india-vix-implied-volatility-source.js";
import type { TradeSide } from "../../../strategy-engine/domain/strategy.js";

function parseTradeHistoryQuery(request: Request): {
  accountId?: string;
  instrumentSymbol?: string;
  status?: PaperTradeStatus;
  side?: TradeSide;
  exitReason?: PaperTradeExitReason;
  outcome?: TradeOutcomeFilter;
  openedFrom?: Date;
  openedTo?: Date;
  limit?: number;
} {
  const openedFrom = queryString(request, "openedFrom");
  const openedTo = queryString(request, "openedTo");
  return {
    accountId: queryString(request, "accountId"),
    instrumentSymbol: queryString(request, "instrument"),
    status: queryString(request, "status")?.toUpperCase() as PaperTradeStatus | undefined,
    side: queryString(request, "side")?.toUpperCase() as TradeSide | undefined,
    exitReason: queryString(request, "exitReason")?.toUpperCase() as PaperTradeExitReason | undefined,
    outcome: queryString(request, "outcome")?.toUpperCase() as TradeOutcomeFilter | undefined,
    openedFrom: openedFrom === undefined ? undefined : parseUtcTimestamp(openedFrom, "openedFrom"),
    openedTo: openedTo === undefined ? undefined : parseUtcTimestamp(openedTo, "openedTo"),
    limit: parseLimit(request),
  };
}

async function loadLivePrices(symbols: readonly string[]): Promise<Record<string, number>> {
  const livePrices: Record<string, number> = {};
  if (symbols.length === 0) return livePrices;

  // Batched rather than one request per symbol: this runs on the account-summary and close
  // paths, which are called with every open position's underlying at once.
  const quotes = await quoteLabSymbols(symbols);
  for (const [symbol, quote] of quotes) {
    livePrices[symbol] = quote.regularMarketPrice!;
  }
  // A symbol absent from the map has no usable quote. Left out rather than defaulted, so the
  // valuation path falls back to a stored mark instead of pricing against a fabricated one.
  return livePrices;
}


/**
 * The freshest observed chain quote for a trade's exact contract, or null.
 *
 * Shared by the summary and close routes deliberately. They used to differ: the summary
 * marked at the observed mid while the close fell back to the model, so the screen showed
 * one price and the account booked another. On a live BANKNIFTY 57700 CE the model mark
 * and the chain mid differed by 179 points -- reporting +Rs 2,032 on a position that was
 * down Rs 651 -- so an exit taken from the wrong one is a wrong realized P&L, not a
 * display nit.
 *
 * Returns null rather than throwing: a chain lookup failure must never cost a position
 * its model mark, which is the difference between a stale number and an unclosable trade.
 */
async function observedChainQuoteFor(
  optionChainRepository: HttpDependencies["optionChainRepository"],
  premiumTickRepository: HttpDependencies["optionPremiumTickRepository"],
  trade: { underlyingSymbol?: string | null; optionExpiry?: Date | null; optionStrike?: number | null; optionType?: string | null },
): Promise<Awaited<ReturnType<HttpDependencies["optionChainRepository"]["latestContractQuote"]>>> {
  if (
    !trade.underlyingSymbol || !(trade.optionExpiry instanceof Date)
    || typeof trade.optionStrike !== "number"
    || (trade.optionType !== "CE" && trade.optionType !== "PE")
  ) {
    return null;
  }
  try {
    const dense = await premiumTickRepository.latestForContract({
      underlyingSymbol: trade.underlyingSymbol.toUpperCase(),
      expiryDate: trade.optionExpiry,
      strikePrice: trade.optionStrike,
      optionType: trade.optionType,
    });
    if (dense?.bid != null && dense.ask != null && dense.bid > 0 && dense.ask >= dense.bid) {
      return {
        mid: (dense.bid + dense.ask) / 2,
        bid: dense.bid,
        ask: dense.ask,
        observedAt: dense.observedAt,
        impliedForward: null,
      };
    }
    return await optionChainRepository.latestContractQuote({
      underlyingSymbol: trade.underlyingSymbol.toUpperCase(),
      expiryDate: trade.optionExpiry,
      strikePrice: trade.optionStrike,
      optionType: trade.optionType,
    });
  } catch {
    return null;
  }
}

export function registerPaperTradingRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies,
    | "database"
    | "listPaperTradeHistory"
    | "dashboardRepository"
    | "paperTradeRepository"
    | "paperTradeNotificationRepository"
    | "optionPremiumTickRepository"
    | "createPaperAccount"
    | "getPaperAccountSummary"
    | "openPaperTrade"
    | "evaluateOpenPaperTrades"
    | "closePaperTrade"
    | "optionChainRepository"
  >,
): void {
  /**
   * Real-time automated trade-open notifications.
   *
   * The scheduler writes trades in a different process, so an in-memory event emitter in the
   * API would miss every bot entry. This stream tails the committed paper_trade_events ledger
   * instead. Delivery is read-only and outside the bot transaction: notification failure can
   * never delay or roll back execution. A snapshot lets the browser establish a no-duplicate
   * baseline and recover events missed during an SSE reconnect.
   */
  app.get("/api/v1/stream/paper-trade-notifications", async (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write("retry: 3000\n\n");

    const knownEventIds = new Set<string>();
    let pollInFlight = false;
    let closed = false;

    const writeEvent = (event: string, data: unknown, id?: string): void => {
      if (closed || response.writableEnded) return;
      if (id) response.write(`id: ${id}\n`);
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const poll = async (initial: boolean): Promise<void> => {
      if (closed || pollInFlight) return;
      pollInFlight = true;
      try {
        const recent = await dependencies.paperTradeNotificationRepository
          .listRecentAutomatedOpens(50);
        if (initial) {
          for (const notification of recent) knownEventIds.add(notification.eventId);
          writeEvent("snapshot", { data: recent });
          return;
        }

        const unseen = recent
          .filter((notification) => !knownEventIds.has(notification.eventId))
          .reverse();
        for (const notification of unseen) {
          knownEventIds.add(notification.eventId);
          writeEvent("trade-opened", notification, notification.eventId);
        }
      } catch {
        // A transient read failure must not terminate EventSource's connection. The next poll
        // re-reads the recent tail and therefore recovers the missed event without bot coupling.
      } finally {
        pollInFlight = false;
      }
    };

    await poll(true);
    const pollInterval = setInterval(() => { void poll(false); }, 2_000);
    const heartbeatInterval = setInterval(() => {
      if (!closed && !response.writableEnded) response.write(": keep-alive\n\n");
    }, 15_000);

    request.on("close", () => {
      closed = true;
      clearInterval(pollInterval);
      clearInterval(heartbeatInterval);
    });
  });

  app.get("/api/v1/paper-trades", async (request, response, next) => {
    try {
      const result = await dependencies.listPaperTradeHistory.execute(parseTradeHistoryQuery(request));
      response.status(200).json({
        data: result.records,
        summary: result.summary,
        page: { limit: result.limit, truncated: result.truncated },
        context: { simulatedOnly: true, accounts: result.accounts },
      });
    } catch (error) {
      if (error instanceof InvalidHttpQueryError || error instanceof InvalidTradeHistoryQueryError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/paper-accounts", async (_request, response, next) => {
    try {
      response.status(200).json({ data: await dependencies.dashboardRepository.listPaperAccounts() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/paper-accounts", async (request, response, next) => {
    try {
      const { name, openingBalance } = request.body || {};
      if (!name || typeof name !== "string" || !openingBalance || typeof openingBalance !== "number") {
        response.status(400).json({ error: "name (string) and openingBalance (number) are required." });
        return;
      }
      response.status(201).json({ data: await dependencies.createPaperAccount.execute({ name, openingBalance }) });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to create paper account");
    }
  });

  app.get("/api/v1/paper-accounts/:id/summary", async (request, response, next) => {
    try {
      const accountId = request.params.id || "";
      const asOf = new Date();
      // Summary polling is read-only. Stop/target execution and reflection writes belong
      // to the scheduler or the explicit POST /paper-trades/evaluate command; otherwise
      // opening a dashboard tab changes the account and multiple tabs race each other.
      const currentOpenTrades = await dependencies.paperTradeRepository.listOpenByAccount(accountId);
      const activeSymbols = [...new Set(
        currentOpenTrades.flatMap((trade) => [
          trade.underlyingSymbol?.toUpperCase(),
          trade.instrumentSymbol?.toUpperCase(),
        ]).filter(
          (symbol): symbol is string => typeof symbol === "string" && symbol.length > 0,
        ),
      )];
      const livePrices = await loadLivePrices(activeSymbols);
      const summary = await dependencies.getPaperAccountSummary.execute(accountId);
      const fullSummary = await dependencies.dashboardRepository.getPaperAccountFullSummary(accountId, summary);
      let currentVolatility: number | null = null;
      try {
        currentVolatility = await new PostgresIndiaVixImpliedVolatilitySource(
          dependencies.database,
        ).resolveAsOf(asOf);
      } catch {
        // Each option valuation can still fall back to its persisted entry IV.
      }
      // An observed chain quote outranks the model mark, so it is looked up per
      // contract before valuing. Absent for most positions -- collection covers a
      // bounded strike window on a few underlyings -- and the model then applies.
      const valuations = new Map(await Promise.all(currentOpenTrades.map(async (trade) => {
        const observedQuote = await observedChainQuoteFor(
          dependencies.optionChainRepository,
          dependencies.optionPremiumTickRepository,
          trade,
        );
        return [
          trade.id,
          valuePaperTrade({ trade, livePrices, asOf, currentVolatility, observedQuote }),
        ] as const;
      })));
      fullSummary.openTrades = fullSummary.openTrades.map((trade) => ({
        ...trade,
        liveValuation: valuations.get(String(trade.id)) ?? {
          status: "UNAVAILABLE",
          source: "UNAVAILABLE",
          markPrice: null,
          underlyingPrice: null,
          unrealizedPnl: null,
          returnPercent: null,
          asOf: asOf.toISOString(),
          volatility: null,
          volatilitySource: null,
          // Explicit nulls, not omitted keys: the client distinguishes "no greeks" from
          // "field absent", and an undefined would read as the latter.
          greeks: null,
          daysToExpiry: null,
          reason: "No live valuation was produced for this open trade.",
        },
      }));
      response.status(200).json({ data: fullSummary });
    } catch (error) {
      respondToRouteError(error, response, next, 404, "Account not found");
    }
  });

  app.post("/api/v1/paper-trades/open", async (request, response, next) => {
    try {
      const {
        accountId,
        tradeIdeaId,
        fillPrice,
        quantity,
        lots,
        notes,
        orderType,
        asOptionBuyer = true,
        impliedVolatility,
        expiryDate,
      } = request.body || {};
      if (!accountId || !tradeIdeaId) {
        response.status(400).json({ error: "accountId and tradeIdeaId are required." });
        return;
      }

      const ideaResult = await dependencies.database.query(`
        SELECT ti.id, ti.side, ti.entry_price, ti.stop_loss, ti.target_price,
               ti.instrument_id, ti.confidence, ti.reasoning, ti.source_candle_id,
               i.lot_size, i.symbol, i.strike_step
        FROM trade_ideas ti
        INNER JOIN instruments i ON i.id = ti.instrument_id
        WHERE ti.id = $1
      `, [tradeIdeaId]);
      const idea = ideaResult.rows[0] as {
        id: string;
        side: TradeSide;
        entry_price: string;
        stop_loss: string;
        target_price: string;
        instrument_id: string;
        lot_size: number;
        symbol: string;
        strike_step: string | null;
        confidence: string | number | null;
        reasoning: unknown;
        source_candle_id: string | null;
      } | undefined;
      if (!idea) {
        response.status(404).json({ error: "Trade idea not found." });
        return;
      }

      const lotSize = Number(idea.lot_size);
      const resolvedQuantity = typeof lots === "number" && lots > 0
        ? lotsToQuantity(Math.floor(lots), lotSize)
        : quantity;
      if (typeof resolvedQuantity !== "number") {
        response.status(400).json({ error: "quantity or lots is required." });
        return;
      }

      let openFill = typeof fillPrice === "number" ? fillPrice : Number(idea.entry_price);
      let stopOverride: number | undefined;
      let targetOverride: number | undefined;
      let sideOverride: TradeSide | undefined;
      let feeMeta: Record<string, unknown> | undefined;
      let optionContract: {
        optionStrike: number;
        optionExpiry: Date;
        optionType: "CE" | "PE";
        underlyingSymbol: string;
        underlyingEntryPrice: number;
        entryIv: number;
      } | undefined;

      if (asOptionBuyer) {
        // The whole option entry sequence lives in `PrepareOptionEntry`, because the
        // paper-trading bot opens positions through the same steps and a second copy of them
        // is where a gate goes missing. Expiry-calendar check, observed-book fill and the
        // pre-trade checklist are all inside it; a refusal names which one refused.
        const prepared = await new PrepareOptionEntry(
          dependencies.database,
          dependencies.optionChainRepository,
        ).execute({
          tradeIdeaId,
          expiryDate,
          impliedVolatility,
          quantity: resolvedQuantity,
        });
        if (!prepared.approved) {
          const status = prepared.reason === "IDEA_NOT_FOUND" ? 404 : 422;
          response.status(status).json({
            error: prepared.explanation,
            reason: prepared.reason,
            ...(prepared.reasons ? { reasons: prepared.reasons } : {}),
            ...(prepared.unchecked ? { unchecked: prepared.unchecked } : {}),
          });
          return;
        }
        openFill = prepared.entry.fillPrice;
        stopOverride = prepared.entry.stopLossOverride;
        targetOverride = prepared.entry.targetPriceOverride;
        sideOverride = prepared.entry.side;
        optionContract = prepared.entry.optionContract;
        feeMeta = prepared.entry.feeBreakdown;
      }

      const trade = await dependencies.openPaperTrade.execute({
        accountId,
        tradeIdeaId,
        fillPrice: openFill,
        quantity: resolvedQuantity,
        openedAt: new Date(),
        entryFees: feeMeta && typeof (feeMeta.entry as { total?: number })?.total === "number"
          ? (feeMeta.entry as { total: number }).total
          : undefined,
        entrySlippage: 0,
        notes: notes || "Opened via UI (option buyer)",
        orderType: orderType === "PENDING" ? "PENDING" : "MARKET",
        stopLossOverride: stopOverride,
        targetPriceOverride: targetOverride,
        sideOverride,
        feeBreakdown: feeMeta,
        applyBrokerageFees: !feeMeta,
        optionContract,
      });
      response.status(201).json({ data: trade });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to open paper trade");
    }
  });

  app.post("/api/v1/paper-trades/open-manual-option", async (request, response, next) => {
    try {
      const {
        accountId,
        underlyingSymbol,
        optionType,
        strike,
        expiryDate,
        fillPrice,
        quantity,
        lots,
        impliedVolatility,
        notes,
      } = request.body || {};

      if (!accountId || !underlyingSymbol || !optionType || !strike || !expiryDate || fillPrice === undefined) {
        response.status(400).json({ error: "accountId, underlyingSymbol, optionType, strike, expiryDate, and fillPrice are required." });
        return;
      }
      const normalizedOptionType = String(optionType).toUpperCase();
      const normalizedSymbol = String(underlyingSymbol).toUpperCase();
      const numericStrike = Number(strike);
      const requestedFill = Number(fillPrice);
      if ((normalizedOptionType !== "CE" && normalizedOptionType !== "PE")
        || !Number.isFinite(numericStrike) || numericStrike <= 0
        || !Number.isFinite(requestedFill) || requestedFill <= 0) {
        response.status(400).json({ error: "optionType must be CE/PE and strike/fillPrice must be positive numbers." });
        return;
      }

      const expiry = resolveOptionExpiryInstant(String(expiryDate));
      if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        response.status(422).json({ error: "Valid future expiryDate is required." });
        return;
      }
      let iv = Number(impliedVolatility);
      if (!Number.isFinite(iv) || iv <= 0) {
        response.status(422).json({ error: "A measured positive impliedVolatility is required; it cannot be guessed." });
        return;
      }
      if (iv > 1) iv /= 100;
      if (iv <= 0 || iv > 5) {
        response.status(422).json({ error: "impliedVolatility is outside the supported range." });
        return;
      }

      const instrumentResult = await dependencies.database.query(`
        SELECT id, symbol, lot_size FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1
      `, [normalizedSymbol]);
      const instrument = instrumentResult.rows[0] as { id: string; symbol: string; lot_size: number } | undefined;
      
      if (!instrument) {
        response.status(404).json({ error: `Instrument ${underlyingSymbol} not found.` });
        return;
      }

      const lotSize = Number(instrument.lot_size);
      const resolvedQuantity = typeof lots === "number" && lots > 0
        ? lotsToQuantity(Math.floor(lots), lotSize)
        : quantity;
      
      if (typeof resolvedQuantity !== "number") {
        response.status(400).json({ error: "quantity or lots is required." });
        return;
      }
      validateQuantity(resolvedQuantity, lotSize);

      const observedQuote = await dependencies.optionChainRepository.latestContractQuote({
        underlyingSymbol: normalizedSymbol,
        expiryDate: expiry,
        strikePrice: numericStrike,
        optionType: normalizedOptionType as "CE" | "PE",
      });
      const quoteAgeMinutes = observedQuote === null
        ? Number.POSITIVE_INFINITY
        : (Date.now() - observedQuote.observedAt.getTime()) / 60_000;
      if (observedQuote?.ask == null || observedQuote.ask <= 0 || quoteAgeMinutes < 0 || quoteAgeMinutes > 40) {
        response.status(422).json({
          error: "A fresh two-sided quote for the exact contract is required before a manual option can be opened.",
        });
        return;
      }
      // A buyer pays the observed ask. The request value is display context only and
      // cannot override the server-side book used to book P&L.
      const serverFillPrice = observedQuote.ask;

      /*
       * Where the underlying actually was when this contract was bought.
       *
       * This used to be `Number(strike)`, which is not a spot at all. Trap detection measures
       * `liveSpot - underlyingEntryPrice`, so anchoring on the strike made an ITM contract
       * look as though the underlying had already moved hundreds of points in its favour --
       * a 57,300 CE with spot at 57,740 reads as +440 against a 28.65-point threshold, so the
       * trap fired on the first evaluation with nothing having happened. The same error made
       * it unfireable for OTM contracts, where the difference is negative.
       *
       * Resolved server-side rather than taken from the request: the client already displays
       * a spot, but an entry anchor that decides exits should not be caller-supplied. The
       * stored chain snapshot is preferred because it is the same observation the strike was
       * chosen from; a live quote is the fallback.
       */
      let underlyingEntryPrice: number | null = null;
      try {
        const snapshot = await dependencies.optionChainRepository.latestSnapshot({
          underlyingSymbol: String(underlyingSymbol).toUpperCase(),
        });
        underlyingEntryPrice = snapshot?.underlyingValue ?? null;
      } catch {
        underlyingEntryPrice = null;
      }
      if (underlyingEntryPrice === null) {
        const livePrices = await loadLivePrices([String(underlyingSymbol).toUpperCase()]);
        underlyingEntryPrice = livePrices[String(underlyingSymbol).toUpperCase()] ?? null;
      }

      const optionContract = {
        optionStrike: numericStrike,
        optionExpiry: expiry,
        optionType: normalizedOptionType as "CE" | "PE",
        underlyingSymbol: instrument.symbol,
        // Omitted rather than guessed when no spot is available. `decideOptionBuyerLiveExit`
        // skips trap detection without an anchor, so the position simply keeps its ordinary
        // stop and target -- a wrong anchor would instead produce confident wrong exits.
        ...(underlyingEntryPrice === null ? {} : { underlyingEntryPrice }),
        entryIv: iv,
      };

      const feeMeta = {
        entry: calculateEntryFees(serverFillPrice, resolvedQuantity),
        option: {
          optionType: normalizedOptionType,
          strike: numericStrike,
          impliedVolatility: iv,
          expiryDate: expiry.toISOString(),
          // The observed spot when available; the strike only as a last resort, and this
          // field is display metadata rather than an input to any exit decision.
          underlyingEntry: underlyingEntryPrice,
          quoteObservedAt: observedQuote.observedAt.toISOString(),
          requestedFill,
          fillSource: "OBSERVED_ASK",
        },
      };

      const trade = await dependencies.paperTradeRepository.openManualOption({
        accountId,
        instrumentId: instrument.id,
        fillPrice: serverFillPrice,
        quantity: resolvedQuantity,
        openedAt: new Date(),
        entryFees: feeMeta.entry.total,
        entrySlippage: 0,
        notes: notes || "Manual option trade from chain",
        sideOverride: "LONG", // Buying options is always LONG
        feeBreakdown: feeMeta,
        optionContract,
      });

      response.status(201).json({ data: trade });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to open manual paper trade");
    }
  });

  app.post("/api/v1/paper-trades/evaluate", async (request, response, next) => {
    try {
      const { accountId } = request.body || {};
      if (!accountId) {
        response.status(400).json({ error: "accountId is required." });
        return;
      }
      const openTrades = await dependencies.paperTradeRepository.listOpenByAccount(accountId);
      const activeSymbols = [...new Set(
        openTrades.flatMap((trade) => [
          trade.instrumentSymbol?.toUpperCase(),
          trade.underlyingSymbol?.toUpperCase(),
        ]).filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0),
      )];
      const result = await dependencies.evaluateOpenPaperTrades.execute({
        accountId,
        asOf: new Date(),
        livePrices: await loadLivePrices(activeSymbols),
      });
      response.status(200).json({ data: result });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to evaluate trades");
    }
  });

  app.post("/api/v1/paper-trades/close", async (request, response, next) => {
    try {
      const { paperTradeId, exitPrice, notes } = request.body || {};
      if (!paperTradeId || typeof exitPrice !== "number") {
        response.status(400).json({ error: "paperTradeId and exitPrice (number) are required." });
        return;
      }
      const openTrade = await dependencies.paperTradeRepository.findOpenById(paperTradeId);
      if (!openTrade) {
        response.status(404).json({ error: `Open paper trade ${paperTradeId} was not found.` });
        return;
      }

      const closedAt = new Date();
      let appliedExitPrice = exitPrice;
      let exitPriceSource: "MANUAL_INPUT" | "SERVER_OPTION_MARK" = "MANUAL_INPUT";
      let valuationDetails: Record<string, unknown> | undefined;

      if (hasAnyOptionContractField(openTrade)) {
        if (!isOptionBuyerTrade(openTrade)) {
          response.status(409).json({ error: "Option position has incomplete contract metadata and cannot be closed safely." });
          return;
        }
        const symbol = openTrade.underlyingSymbol ?? openTrade.instrumentSymbol;
        const livePrices = symbol ? await loadLivePrices([symbol.toUpperCase()]) : {};
        let currentVolatility: number | null = null;
        try {
          currentVolatility = await new PostgresIndiaVixImpliedVolatilitySource(
            dependencies.database,
          ).resolveAsOf(closedAt);
        } catch {
          // valuePaperTrade will use the persisted entry IV or fail closed.
        }
        // The exit price becomes realized P&L, so it is marked from the same observed
        // quote the summary displays. Without this the screen and the books disagree.
        const observedQuote = await observedChainQuoteFor(
          dependencies.optionChainRepository,
          dependencies.optionPremiumTickRepository,
          openTrade,
        );
        const valuation = valuePaperTrade({
          trade: openTrade,
          livePrices,
          asOf: closedAt,
          currentVolatility,
          observedQuote,
        });
        if (valuation.status !== "AVAILABLE" || valuation.markPrice === null) {
          response.status(409).json({
            error: `Option position cannot be closed safely: ${valuation.reason ?? "premium mark is unavailable."}`,
          });
          return;
        }
        // Closing a long option means selling it. A fresh observed bid is executable; the mid is
        // a valuation mark only. Fall back to the server model/chain mid when no bid exists.
        appliedExitPrice = observedQuote?.bid != null && observedQuote.bid > 0
          ? observedQuote.bid
          : valuation.markPrice;
        exitPriceSource = "SERVER_OPTION_MARK";
        valuationDetails = {
          requestedExitPrice: exitPrice,
          appliedExitPrice,
          underlyingPrice: valuation.underlyingPrice,
          volatility: valuation.volatility,
          volatilitySource: valuation.volatilitySource,
          // Persisted because a realized P&L is only as trustworthy as the mark behind it,
          // and "which mark was this?" is unanswerable after the fact otherwise.
          markSource: valuation.source,
          observedQuoteAt: observedQuote?.observedAt.toISOString() ?? null,
          asOf: valuation.asOf,
          optionStrike: openTrade.optionStrike,
          optionExpiry: openTrade.optionExpiry?.toISOString(),
          optionType: openTrade.optionType,
        };
      }

      const trade = await dependencies.closePaperTrade.execute({
        paperTradeId,
        exitPrice: appliedExitPrice,
        closedAt,
        exitSlippage: 0,
        notes: notes || "Manually closed from UI",
        exitPriceSource,
        valuationDetails,
      });
      response.status(200).json({
        data: trade,
        execution: { requestedExitPrice: exitPrice, appliedExitPrice, exitPriceSource },
      });
    } catch (error) {
      respondToRouteError(error, response, next, 400, "Failed to close trade");
    }
  });
}
