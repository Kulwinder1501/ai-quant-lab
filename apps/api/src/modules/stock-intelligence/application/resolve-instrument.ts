import type { Instrument, InstrumentRepository } from "../../market-data/domain/instrument.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";
import {
  aliasKey,
  InstrumentResolveError,
  isInstrumentUuid,
  isIsin,
  normalizeInstrumentQuery,
  type InstrumentResolveResult,
  type ResolvedInstrument,
} from "../domain/identity.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export class ResolveInstrument {
  constructor(
    private readonly instruments: InstrumentRepository,
    private readonly store: StockIntelligenceStore,
  ) {}

  async execute(rawQuery: string): Promise<ResolvedInstrument> {
    const result = await this.inspect(rawQuery);
    if (result.status !== "RESOLVED" || result.instrument === null) {
      throw new InstrumentResolveError(result);
    }
    return result.instrument;
  }

  async inspect(rawQuery: string): Promise<InstrumentResolveResult> {
    const query = normalizeInstrumentQuery(rawQuery);
    if (!query) {
      return { query: rawQuery, status: "NOT_FOUND", instrument: null, candidates: [], matchedBy: null };
    }

    if (isInstrumentUuid(query)) {
      const instrument = await this.instruments.findById(query);
      return this.finish(query, instrument ? [instrument] : [], "id");
    }

    if (isIsin(query)) {
      const matches = await this.instruments.findByIsin(query);
      return this.finish(query, matches, "isin");
    }

    const aliasInstrumentId = await this.store.findAlias(aliasKey(query));
    if (aliasInstrumentId) {
      const instrument = await this.instruments.findById(aliasInstrumentId);
      return this.finish(query, instrument ? [instrument] : [], "alias");
    }

    const asSymbol = query.toUpperCase().replace(/\.NS$/i, "");
    const bySymbol = await this.instruments.findByExchangeAndSymbol("NSE", asSymbol);
    if (bySymbol) {
      const matchedBy = /\.NS$/i.test(query) ? "yahoo_symbol" : "symbol";
      return this.finish(query, [bySymbol], matchedBy);
    }

    return { query, status: "NOT_FOUND", instrument: null, candidates: [], matchedBy: null };
  }

  private finish(
    query: string,
    instruments: Instrument[],
    matchedBy: InstrumentResolveResult["matchedBy"],
  ): InstrumentResolveResult {
    const candidates = instruments.map(toResolvedInstrument);
    if (candidates.length === 1) {
      return { query, status: "RESOLVED", instrument: candidates[0]!, candidates, matchedBy };
    }
    if (candidates.length === 0) {
      return { query, status: "NOT_FOUND", instrument: null, candidates: [], matchedBy: null };
    }
    return { query, status: "AMBIGUOUS", instrument: null, candidates, matchedBy };
  }
}

export function toResolvedInstrument(instrument: Instrument): ResolvedInstrument {
  const yahooFromMetadata = typeof instrument.metadata.yahooSymbol === "string"
    ? instrument.metadata.yahooSymbol
    : resolveYahooSymbol(instrument.symbol);
  return {
    instrumentId: instrument.id,
    exchange: instrument.exchange,
    symbol: instrument.symbol,
    yahooSymbol: yahooFromMetadata,
    companyName: instrument.displayName,
    isin: instrument.isin,
    instrumentType: instrument.instrumentType,
  };
}
