import type { HistoricalMarketDataProvider } from "../../market-data/domain/historical-data-provider.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";
import { barFromHistoricalCandle, type CanonicalMarketBar, type MarketDataAdapter } from "../domain/adapters.js";
import { assertAvailableAtCutoff } from "../domain/timestamps.js";

/**
 * First MarketDataAdapter. It does not import yahoo-finance2: it talks to the existing
 * historical provider port. Engines never see this class.
 *
 * Yahoo's chart `close` is split-adjusted history, not an as-traded print, and `adjclose`
 * additionally back-propagates dividends. This adapter keeps `close` and never reads
 * `adjclose`. Feed those bars to `calculateAdjustedHorizonReturn` with
 * `priceSeriesBasis: "split_adjusted"` so split factors from CorporateActionStore are
 * not applied twice. Cash dividends are still added from the store.
 */
export class YahooMarketDataAdapter implements MarketDataAdapter {
  constructor(private readonly provider: HistoricalMarketDataProvider) {}

  async fetchDailyBars(input: {
    instrumentId: string;
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<readonly CanonicalMarketBar[]> {
    const candles = await this.provider.fetchCandles({
      providerInstrumentId: resolveYahooSymbol(input.symbol),
      timeframe: "1d",
      from: input.from,
      to: input.to.getTime() > input.dataCutoff.getTime() ? input.dataCutoff : input.to,
    });

    const kept: CanonicalMarketBar[] = [];
    for (const candle of candles) {
      const bar = barFromHistoricalCandle(input.instrumentId, candle);
      if (bar.availableAt.getTime() > input.dataCutoff.getTime()) continue;
      assertAvailableAtCutoff(bar.availableAt, input.dataCutoff, `yahoo-bar:${input.instrumentId}:${bar.closeTime.toISOString()}`);
      kept.push(bar);
    }
    return kept;
  }
}
