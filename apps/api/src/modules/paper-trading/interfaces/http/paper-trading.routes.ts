import type { Express, Request } from "express";
import yahooFinance from "yahoo-finance2";
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
import { lotsToQuantity } from "../../domain/lot-size-validator.js";
import { mapIdeaToOptionBuyerFill } from "../../domain/option-buyer-fill.js";
import { isOptionBuyerTrade } from "../../domain/option-mark-to-market.js";
import {
  hasAnyOptionContractField,
  valuePaperTrade,
} from "../../domain/paper-trade-live-valuation.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../infrastructure/india-vix-implied-volatility-source.js";
import { regimeSourceInstrumentSymbol } from "../../../strategy-engine/domain/regime.js";
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

  const yf = new (yahooFinance as any)();
  for (const symbol of symbols) {
    let yfSymbol = symbol;
    if (symbol === "NIFTY50") yfSymbol = "^NSEI";
    else if (symbol === "BANKNIFTY") yfSymbol = "^NSEBANK";
    else if (!symbol.includes(".")) yfSymbol = `${symbol}.NS`;

    try {
      const quote = await yf.quote(yfSymbol);
      if (quote?.regularMarketPrice) livePrices[symbol] = quote.regularMarketPrice;
    } catch (error) {
      console.error(`Failed to fetch live price for ${symbol}:`, error);
    }
  }
  return livePrices;
}

export function registerPaperTradingRoutes(
  app: Express,
  dependencies: Pick<HttpDependencies,
    | "database"
    | "listPaperTradeHistory"
    | "dashboardRepository"
    | "paperTradeRepository"
    | "createPaperAccount"
    | "getPaperAccountSummary"
    | "openPaperTrade"
    | "evaluateOpenPaperTrades"
    | "closePaperTrade"
    | "aiAutonomousAgent"
  >,
): void {
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

  app.post("/api/v1/paper-accounts", async (request, response) => {
    try {
      const { name, openingBalance } = request.body || {};
      if (!name || typeof name !== "string" || !openingBalance || typeof openingBalance !== "number") {
        response.status(400).json({ error: "name (string) and openingBalance (number) are required." });
        return;
      }
      response.status(201).json({ data: await dependencies.createPaperAccount.execute({ name, openingBalance }) });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to create paper account" });
    }
  });

  app.get("/api/v1/paper-accounts/:id/summary", async (request, response) => {
    try {
      const accountId = request.params.id || "";
      const asOf = new Date();
      let livePrices: Record<string, number> = {};
      try {
        const openTrades = await dependencies.paperTradeRepository.listOpenByAccount(accountId);
        const pendingTrades = await dependencies.paperTradeRepository.listPendingByAccount(accountId);
        const activeSymbols = [...new Set(
          [...openTrades, ...pendingTrades].flatMap((trade) => [
            trade.underlyingSymbol?.toUpperCase(),
            trade.instrumentSymbol?.toUpperCase(),
          ]).filter(
            (symbol): symbol is string => typeof symbol === "string" && symbol.length > 0,
          ),
        )];
        livePrices = await loadLivePrices(activeSymbols);
        const result = await dependencies.evaluateOpenPaperTrades.execute({
          accountId,
          asOf,
          livePrices,
        });
        if (result.tradesClosed > 0) {
          for (const closedId of result.closedTradeIds) {
            await dependencies.aiAutonomousAgent.generateSelfReflection(closedId, "NIFTY50");
          }
        }
      } catch {
        // Live evaluation is best effort during summary polling.
      }
      const summary = await dependencies.getPaperAccountSummary.execute(accountId);
      const fullSummary = await dependencies.dashboardRepository.getPaperAccountFullSummary(accountId, summary);
      const currentOpenTrades = await dependencies.paperTradeRepository.listOpenByAccount(accountId);
      let currentVolatility: number | null = null;
      try {
        currentVolatility = await new PostgresIndiaVixImpliedVolatilitySource(
          dependencies.database,
        ).resolveAsOf(asOf);
      } catch {
        // Each option valuation can still fall back to its persisted entry IV.
      }
      const valuations = new Map(currentOpenTrades.map((trade) => [
        trade.id,
        valuePaperTrade({ trade, livePrices, asOf, currentVolatility }),
      ]));
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
    } catch (error: any) {
      response.status(404).json({ error: error.message || "Account not found" });
    }
  });

  app.post("/api/v1/paper-trades/open", async (request, response) => {
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
               ti.instrument_id, i.lot_size, i.symbol, i.strike_step
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
        entryIv: number;
      } | undefined;

      if (asOptionBuyer) {
        let iv = typeof impliedVolatility === "number" ? impliedVolatility : undefined;
        if (iv === undefined) {
          const vixClose = await dependencies.database.query(`
            SELECT c.close
            FROM candles c
            INNER JOIN instruments i ON i.id = c.instrument_id
            WHERE i.symbol = $1
              AND c.timeframe = '1d'
              AND c.is_complete = TRUE
              AND c.close_time <= CURRENT_TIMESTAMP
            ORDER BY c.close_time DESC
            LIMIT 1
          `, [regimeSourceInstrumentSymbol]);
          if (vixClose.rows[0]) iv = Number((vixClose.rows[0] as { close: string }).close) / 100;
        }
        if (iv === undefined || !Number.isFinite(iv) || iv <= 0) iv = 0.12;
        if (iv > 1) iv /= 100;

        const strikeStep = idea.strike_step === null ? null : Number(idea.strike_step);
        if (strikeStep === null || !Number.isFinite(strikeStep) || strikeStep <= 0) {
          response.status(422).json({
            error: `Instrument ${idea.symbol} has no strike_step configured, so an option strike cannot be chosen.`,
          });
          return;
        }
        if (typeof expiryDate !== "string" || expiryDate.trim() === "") {
          response.status(422).json({
            error: "expiryDate is required when opening an option-buyer position; "
              + "it names the contract being priced and cannot be inferred.",
          });
          return;
        }
        const expiry = new Date(expiryDate);
        if (Number.isNaN(expiry.getTime())) {
          response.status(422).json({ error: `expiryDate "${expiryDate}" is not a valid date.` });
          return;
        }
        if (expiry.getTime() <= Date.now()) {
          response.status(422).json({
            error: `expiryDate ${expiry.toISOString()} has already passed; an expired contract cannot be priced.`,
          });
          return;
        }

        let mapped: ReturnType<typeof mapIdeaToOptionBuyerFill>;
        try {
          mapped = mapIdeaToOptionBuyerFill({
            ideaSide: idea.side,
            underlyingEntry: Number(idea.entry_price),
            underlyingStop: Number(idea.stop_loss),
            underlyingTarget: Number(idea.target_price),
            impliedVolatility: iv,
            expiryDate: expiry,
            strikeStep,
          });
        } catch (error) {
          response.status(422).json({
            error: error instanceof Error ? error.message : "Option fill could not be derived.",
          });
          return;
        }
        openFill = mapped.fillPremium;
        stopOverride = mapped.stopPremium;
        targetOverride = mapped.targetPremium;
        sideOverride = mapped.side;
        optionContract = {
          optionStrike: mapped.strike,
          optionExpiry: expiry,
          optionType: mapped.optionType,
          underlyingSymbol: idea.symbol,
          entryIv: iv,
        };
        feeMeta = {
          entry: calculateEntryFees(openFill, resolvedQuantity),
          option: {
            optionType: mapped.optionType,
            strike: mapped.strike,
            impliedVolatility: iv,
            expiryDate: expiry.toISOString(),
            greeks: mapped.entryGreeks,
            underlyingEntry: Number(idea.entry_price),
          },
        };
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
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to open paper trade" });
    }
  });

  app.post("/api/v1/paper-trades/evaluate", async (request, response) => {
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
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to evaluate trades" });
    }
  });

  app.post("/api/v1/paper-trades/close", async (request, response) => {
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
        const valuation = valuePaperTrade({
          trade: openTrade,
          livePrices,
          asOf: closedAt,
          currentVolatility,
        });
        if (valuation.status !== "AVAILABLE" || valuation.markPrice === null) {
          response.status(409).json({
            error: `Option position cannot be closed safely: ${valuation.reason ?? "premium mark is unavailable."}`,
          });
          return;
        }
        appliedExitPrice = valuation.markPrice;
        exitPriceSource = "SERVER_OPTION_MARK";
        valuationDetails = {
          requestedExitPrice: exitPrice,
          appliedExitPrice,
          underlyingPrice: valuation.underlyingPrice,
          volatility: valuation.volatility,
          volatilitySource: valuation.volatilitySource,
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
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to close trade" });
    }
  });
}
