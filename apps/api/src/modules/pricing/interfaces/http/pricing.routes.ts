import type { Express, Request, Response } from "express";
import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { queryString } from "../../../../interfaces/http/common/query.js";
import { calculateEntryFees, calculateExitFees, calculateTotalFees } from "../../../paper-trading/domain/brokerage-calculator.js";
import { lotsToQuantity } from "../../../paper-trading/domain/lot-size-validator.js";
import { priceOption } from "../../application/price-option.js";

export function registerPricingRoutes(
  app: Express,
  { instrumentRepository }: Pick<HttpDependencies, "instrumentRepository">,
): void {
  app.get("/api/v1/pricing/options", async (request, response, next) => {
    try {
      const underlyingPrice = Number(queryString(request, "underlyingPrice"));
      const strikePrice = Number(queryString(request, "strikePrice"));
      const expiryRaw = queryString(request, "expiryDate");
      const optionTypeRaw = (queryString(request, "optionType") || "").toUpperCase();
      const ivRaw = Number(queryString(request, "iv") ?? queryString(request, "impliedVolatility"));
      if (!Number.isFinite(underlyingPrice) || !Number.isFinite(strikePrice) || !expiryRaw || !Number.isFinite(ivRaw)) {
        response.status(400).json({
          error: "underlyingPrice, strikePrice, expiryDate, optionType, and iv are required.",
        });
        return;
      }
      if (optionTypeRaw !== "CE" && optionTypeRaw !== "PE") {
        response.status(400).json({ error: "optionType must be CE or PE." });
        return;
      }
      response.status(200).json({
        data: priceOption({
          underlyingPrice,
          strikePrice,
          expiryDate: new Date(expiryRaw),
          optionType: optionTypeRaw,
          impliedVolatility: ivRaw,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  const lotInfo = async (
    instrument: Awaited<ReturnType<typeof instrumentRepository.findById>>,
    request: Request,
    response: Response,
  ) => {
    const premium = Number(queryString(request, "premium") ?? 100);
    const lots = Math.max(1, Math.floor(Number(queryString(request, "lots") ?? 1)));
    const quantity = lotsToQuantity(lots, instrument!.lotSize);
    const entry = calculateEntryFees(premium, quantity);
    const exit = calculateExitFees(premium, quantity);
    const roundTrip = calculateTotalFees(premium, premium, quantity);
    response.status(200).json({
      data: {
        instrumentId: instrument!.id,
        symbol: instrument!.symbol,
        lotSize: instrument!.lotSize,
        tickSize: instrument!.tickSize,
        lots,
        quantity,
        premium,
        feeEstimate: {
          entry,
          exit,
          roundTripTotal: roundTrip.total,
          totalCost: Number((premium * quantity + entry.total).toFixed(2)),
        },
      },
    });
  };

  app.get("/api/v1/instruments/:id/lot-info", async (request, response, next) => {
    try {
      const instrument = await instrumentRepository.findById(request.params.id || "");
      if (!instrument) {
        response.status(404).json({ error: "Instrument not found." });
        return;
      }
      await lotInfo(instrument, request, response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/instruments/by-symbol/:symbol/lot-info", async (request, response, next) => {
    try {
      const symbol = (request.params.symbol || "").toUpperCase();
      const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
      if (!instrument) {
        response.status(404).json({ error: `Instrument ${symbol} not found.` });
        return;
      }
      await lotInfo(instrument, request, response);
    } catch (error) {
      next(error);
    }
  });
}
