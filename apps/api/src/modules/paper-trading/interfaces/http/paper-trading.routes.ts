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
import {
  mapIdeaToOptionBuyerFill,
  resolveOptionExpiryInstant,
} from "../../domain/option-buyer-fill.js";
import { resolveListedExpiry } from "../../../market-data/domain/option-expiry-calendar.js";
import { nearestStrike } from "@ai-quant-lab/pricing";
import { solveContractGreeksFromChain } from "../../../market-data/domain/chain-greeks.js";
import { validateOptionsEntry } from "../../../strategy-engine/domain/options-entry-validator.js";
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
    | "createPaperAccount"
    | "getPaperAccountSummary"
    | "openPaperTrade"
    | "evaluateOpenPaperTrades"
    | "closePaperTrade"
    | "aiAutonomousAgent"
    | "optionChainRepository"
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
      // An observed chain quote outranks the model mark, so it is looked up per
      // contract before valuing. Absent for most positions -- collection covers a
      // bounded strike window on a few underlyings -- and the model then applies.
      const valuations = new Map(await Promise.all(currentOpenTrades.map(async (trade) => {
        const observedQuote = await observedChainQuoteFor(
          dependencies.optionChainRepository,
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
      // What the pre-trade gate saw, persisted with the trade: a position that passed a
      // partially-unchecked gate should say so on its own record.
      let feeMetaEntryChecks: Record<string, unknown> | undefined;
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
        // A date-only expiry means that day's 15:30 IST settlement, not midnight UTC.
        const expiry = resolveOptionExpiryInstant(expiryDate);
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
        // A well-formed future date is not yet a contract. Two trades were booked against a
        // BANKNIFTY 2026-08-04 expiry that underlying does not list, and priced cleanly the
        // whole way through, so the requested expiry is checked against the provider's own
        // calendar before anything is derived from it.
        const calendar = await dependencies.optionChainRepository
          .latestExpiryCalendar(String(idea.symbol).toUpperCase());
        const listed = resolveListedExpiry(calendar, expiry, String(idea.symbol).toUpperCase());
        if (!listed.usable) {
          response.status(422).json({ error: listed.explanation, reason: listed.reason });
          return;
        }
        // The calendar's own instant, so a caller who passed a bare date does not end up
        // with a settlement time that disagrees with the contract.
        const settlementExpiry = listed.expiryDate;

        // The chain is read before the fill is mapped, because the entry premium should be
        // the market's rather than the model's. The strike does not depend on the mapping --
        // it is `nearestStrike(entry, step)` -- so it can be derived here and looked up.
        const intendedStrike = nearestStrike(Number(idea.entry_price), strikeStep);
        const intendedOptionType = idea.side === "LONG" ? "CE" : "PE";
        const entryChain = await dependencies.optionChainRepository
          .latestSnapshot({
            underlyingSymbol: String(idea.symbol).toUpperCase(),
            expiryDate: settlementExpiry.toISOString().slice(0, 10),
          })
          .catch(() => null);
        const solvedGreeks = entryChain === null ? null : solveContractGreeksFromChain({
          snapshot: entryChain,
          strikePrice: intendedStrike,
          optionType: intendedOptionType,
        });
        // A buyer pays the ask, not the mid. Filling at the mid would understate the entry by
        // half the spread on every trade, and spread is the cost that decides whether an
        // options edge survives at all -- the measured straddle edge dies at roughly 1.09% per
        // leg. The ask is what the book was actually offering.
        const intendedQuote = entryChain?.quotes.find(
          (quote) => quote.strikePrice === intendedStrike && quote.optionType === intendedOptionType,
        );
        const observedFill = solvedGreeks !== null && intendedQuote?.ask != null && intendedQuote.ask > 0
          ? { premium: intendedQuote.ask, impliedVolatility: solvedGreeks.impliedVolatility }
          : undefined;

        let mapped: ReturnType<typeof mapIdeaToOptionBuyerFill>;
        try {
          mapped = mapIdeaToOptionBuyerFill({
            ideaSide: idea.side,
            underlyingEntry: Number(idea.entry_price),
            underlyingStop: Number(idea.stop_loss),
            underlyingTarget: Number(idea.target_price),
            impliedVolatility: iv,
            expiryDate: settlementExpiry,
            strikeStep,
            observedFill,
          });
        } catch (error) {
          response.status(422).json({
            error: error instanceof Error ? error.message : "Option fill could not be derived.",
          });
          return;
        }
        // Pre-trade gate on the contract that was actually chosen, reusing the snapshot and
        // solved greeks the fill was priced from -- a second read could land on a newer
        // observation and gate a position against a book it was not filled at.
        //
        // A refusal returns `unchecked` alongside `reasons`, because "passed" and "never
        // evaluated" must not look the same to the caller -- that conflation is exactly how
        // this project shipped guards that never fired.
        // Volume of the bar the idea was actually raised on, via `source_candle_id`. The
        // latest bar is deliberately not substituted: validating an older idea against a
        // later bar would judge it on information it never had.
        //
        // A zero is only treated as "nobody traded" when the series demonstrably reports
        // volume. Every stored 15m index bar has zero volume because the provider supplies
        // no intraday index volume, and reading that as no participation would refuse every
        // index option entry. The probe is per instrument and timeframe, so the check starts
        // working on its own if the provider ever begins supplying it.
        let candleVolume: number | null = null;
        let volumeAbsenceReason = "the idea records no source candle, so its bar volume cannot be read";
        if (idea.source_candle_id) {
          try {
            const sourceBar = await dependencies.database.query(`
              SELECT c.volume, c.timeframe, c.instrument_id,
                     (SELECT count(*) FROM candles peer
                       WHERE peer.instrument_id = c.instrument_id
                         AND peer.timeframe = c.timeframe
                         AND peer.volume > 0) AS series_volume_bars
              FROM candles c WHERE c.id = $1
            `, [idea.source_candle_id]);
            const bar = sourceBar.rows[0] as
              { volume: string | null; timeframe: string; series_volume_bars: string } | undefined;
            if (!bar) {
              volumeAbsenceReason = "the idea's source candle is no longer stored";
            } else if (Number(bar.series_volume_bars) === 0) {
              volumeAbsenceReason =
                `${idea.symbol} ${bar.timeframe} carries no volume in this dataset, so a zero `
                + "cannot be read as absent participation";
            } else {
              const parsed = bar.volume === null ? Number.NaN : Number(bar.volume);
              if (Number.isFinite(parsed)) candleVolume = parsed;
              else volumeAbsenceReason = "the source candle stores no volume";
            }
          } catch {
            // A volume lookup failure must not block an entry; it is reported as unchecked.
            volumeAbsenceReason = "the source candle's volume could not be read";
          }
        }

        const reasoningList = Array.isArray(idea.reasoning)
          ? (idea.reasoning as unknown[]).map(String)
          : [];
        const entryCheck = validateOptionsEntry({
          proposedIdea: {
            side: idea.side,
            confidence: Number(idea.confidence ?? 0),
            reasoning: reasoningList,
          },
          candleVolume,
          volumeAbsenceReason,
          optionChain: entryChain ?? undefined,
          intendedStrike: intendedStrike,
          intendedContractDelta: solvedGreeks?.delta ?? null,
        });
        if (!entryCheck.isValid) {
          response.status(422).json({
            error: `Options pre-trade checks refused this entry: ${entryCheck.reasons.join(" ")}`,
            reason: "OPTIONS_ENTRY_REJECTED",
            reasons: entryCheck.reasons,
            unchecked: entryCheck.unchecked,
          });
          return;
        }
        feeMetaEntryChecks = {
          fillSource: mapped.fillSource,
          sourceCandleVolume: candleVolume,
          observedAsk: intendedQuote?.ask ?? null,
          reasons: entryCheck.reasons,
          unchecked: entryCheck.unchecked,
          solvedDelta: solvedGreeks?.delta ?? null,
          solvedImpliedVolatility: solvedGreeks?.impliedVolatility ?? null,
          chainObservedAt: entryChain?.observedAt.toISOString() ?? null,
        };

        openFill = mapped.fillPremium;
        stopOverride = mapped.stopPremium;
        targetOverride = mapped.targetPremium;
        sideOverride = mapped.side;
        optionContract = {
          optionStrike: mapped.strike,
          optionExpiry: settlementExpiry,
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
            // The contract's settlement instant, matching what the trade is booked against.
            // Recording the caller's raw input here would disagree with `optionExpiry`
            // whenever a bare date was supplied.
            expiryDate: settlementExpiry.toISOString(),
            greeks: mapped.entryGreeks,
            underlyingEntry: Number(idea.entry_price),
          },
          entryChecks: feeMetaEntryChecks,
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

  app.post("/api/v1/paper-trades/open-manual-option", async (request, response) => {
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

      const instrumentResult = await dependencies.database.query(`
        SELECT id, symbol, lot_size FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1
      `, [underlyingSymbol]);
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

      // Synthesize a trade idea for this manual entry
      const ideaResult = await dependencies.database.query(`
        INSERT INTO trade_ideas (
          instrument_id,
          strategy_version_id,
          source_candle_id,
          side,
          status,
          entry_price,
          stop_loss,
          target_price,
          risk_reward,
          confidence,
          reasoning,
          evidence,
          expires_at
        ) VALUES (
          $1, NULL, NULL, $2, 'PROPOSED', $3, $4, $5, 0, 1.0, '{"summary":"Manual options chain trade"}', '[]', NOW() + INTERVAL '1 day'
        ) RETURNING id
      `, [
        instrument.id,
        optionType === "CE" ? "LONG" : "SHORT", // Direction mapping for options
        fillPrice,
        fillPrice * 0.5, // Dummy stop loss in underlying terms (not used since we override)
        fillPrice * 2.0, // Dummy target in underlying terms
      ]);
      const tradeIdeaId = ideaResult.rows[0]?.id;

      // Now prepare the options contract info
      const expiry = resolveOptionExpiryInstant(expiryDate);
      if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        response.status(422).json({ error: "Valid future expiryDate is required." });
        return;
      }

      let iv = typeof impliedVolatility === "number" ? impliedVolatility : 0.15;
      if (iv > 1) iv /= 100;

      const optionContract = {
        optionStrike: Number(strike),
        optionExpiry: expiry,
        optionType: optionType as "CE" | "PE",
        underlyingSymbol: instrument.symbol,
        entryIv: iv,
      };

      const feeMeta = {
        entry: calculateEntryFees(Number(fillPrice), resolvedQuantity),
        option: {
          optionType,
          strike: Number(strike),
          impliedVolatility: iv,
          expiryDate: expiry.toISOString(),
          underlyingEntry: Number(strike), // Assuming ATM for margin
        },
      };

      const trade = await dependencies.openPaperTrade.execute({
        accountId,
        tradeIdeaId,
        fillPrice: Number(fillPrice),
        quantity: resolvedQuantity,
        openedAt: new Date(),
        entryFees: feeMeta && typeof (feeMeta.entry as { total?: number })?.total === "number"
          ? (feeMeta.entry as { total: number }).total
          : undefined,
        entrySlippage: 0,
        notes: notes || "Manual option trade from chain",
        orderType: "MARKET",
        sideOverride: "LONG", // Buying options is always LONG
        feeBreakdown: feeMeta,
        applyBrokerageFees: !feeMeta,
        optionContract,
      });

      response.status(201).json({ data: trade });
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to open manual paper trade" });
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
        // The exit price becomes realized P&L, so it is marked from the same observed
        // quote the summary displays. Without this the screen and the books disagree.
        const observedQuote = await observedChainQuoteFor(
          dependencies.optionChainRepository,
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
        appliedExitPrice = valuation.markPrice;
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
    } catch (error: any) {
      response.status(400).json({ error: error.message || "Failed to close trade" });
    }
  });
}
