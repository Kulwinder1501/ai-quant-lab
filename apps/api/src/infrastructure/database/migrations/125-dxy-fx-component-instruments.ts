import type { Migration } from "../migration-runner.js";

/**
 * Registers the 6 currency pairs the real ICE US Dollar Index formula is computed from --
 * EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK, USD/CHF -- under the TWELVEDATA exchange.
 *
 * Migration 119 registered `DXY` itself and declared Twelve Data as its provenance, but Twelve
 * Data does not carry the US Dollar Index under any symbol (confirmed 2026-10-06 against their
 * live `/indices` catalog, 1,308 entries, zero matches for "dollar" or "dxy" in either name or
 * symbol) -- every `XAU_CANDLE_COLLECTION` run has been requesting a ticker that does not exist
 * and failing with HTTP 404 on every attempt. Twelve Data does carry all 6 of DXY's real
 * component pairs (spot-checked live), so `compute-synthetic-dxy.ts` reconstructs the real index
 * from them via the public formula instead of a vendor that does not sell it:
 *
 *   DXY = 50.14348112 * EURUSD^-0.576 * USDJPY^0.136 * GBPUSD^-0.119
 *                     * USDCAD^0.091 * USDSEK^0.042 * USDCHF^0.036
 *
 * `instrument_type` had no value for a currency pair (CHECK'd to INDEX|EQUITY|ETF|OPTION|FUTURE
 * since the initial schema); widened here to add FOREX rather than mis-tag these as INDEX.
 */
export const dxyFxComponentInstrumentsMigration: Migration = {
  id: "125-dxy-fx-component-instruments",
  sql: `
    ALTER TABLE instruments DROP CONSTRAINT instruments_instrument_type_check;
    ALTER TABLE instruments ADD CONSTRAINT instruments_instrument_type_check
      CHECK (instrument_type IN ('INDEX', 'EQUITY', 'ETF', 'OPTION', 'FUTURE', 'FOREX'));

    INSERT INTO instruments (exchange, symbol, display_name, instrument_type, currency, tick_size, lot_size)
    VALUES
      ('TWELVEDATA', 'EUR_USD', 'Euro / US Dollar', 'FOREX', 'USD', 0.00001, 1),
      ('TWELVEDATA', 'USD_JPY', 'US Dollar / Japanese Yen', 'FOREX', 'USD', 0.001, 1),
      ('TWELVEDATA', 'GBP_USD', 'British Pound / US Dollar', 'FOREX', 'USD', 0.00001, 1),
      ('TWELVEDATA', 'USD_CAD', 'US Dollar / Canadian Dollar', 'FOREX', 'USD', 0.00001, 1),
      ('TWELVEDATA', 'USD_SEK', 'US Dollar / Swedish Krona', 'FOREX', 'USD', 0.00001, 1),
      ('TWELVEDATA', 'USD_CHF', 'US Dollar / Swiss Franc', 'FOREX', 'USD', 0.00001, 1)
    ON CONFLICT (exchange, symbol) DO NOTHING;

    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT i.id, tf.timeframe, 'twelvedata'
    FROM instruments i
    CROSS JOIN (VALUES ('1m'), ('5m'), ('15m')) AS tf(timeframe)
    WHERE i.exchange = 'TWELVEDATA'
      AND i.symbol IN ('EUR_USD', 'USD_JPY', 'GBP_USD', 'USD_CAD', 'USD_SEK', 'USD_CHF')
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;
  `,
};
