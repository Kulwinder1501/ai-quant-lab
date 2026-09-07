import yahooFinance from "yahoo-finance2";
import { YAHOO_PROVIDER_ID } from "../../modules/market-data/domain/candle-provenance.js";
import { resolveYahooSymbol } from "../../modules/market-data/domain/yahoo-symbol-resolver.js";
import {
  corporateActionsFromYahooEvents,
  type CorporateActionAdapter,
  type DiscoveredCorporateAction,
} from "../../modules/stock-intelligence/application/corporate-action-adapter.js";

/**
 * MVP corporate-action source. Official BSE/NSE filings replace this without
 * touching AdjustmentEngine. Engines never import this file.
 */
export class YahooCorporateActionAdapter implements CorporateActionAdapter {
  readonly id = YAHOO_PROVIDER_ID;

  async fetchActions(input: {
    instrumentId: string;
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<readonly DiscoveredCorporateAction[]> {
    const to = input.to.getTime() > input.dataCutoff.getTime() ? input.dataCutoff : input.to;
    const yf = new (yahooFinance as any)({ suppressNotices: ["ripHistorical"] });
    const results = await yf.chart(resolveYahooSymbol(input.symbol), {
      period1: input.from,
      period2: to,
      interval: "1d",
      events: "div|split",
    });
    return corporateActionsFromYahooEvents(results.events, input.dataCutoff);
  }
}
