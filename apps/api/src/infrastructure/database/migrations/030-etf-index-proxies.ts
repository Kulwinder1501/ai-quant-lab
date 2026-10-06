import type { Migration } from "../migration-runner.js";

/**
 * Registers liquid ETF index proxies as the intraday instrument that actually carries
 * traded volume.
 *
 * Why not the spot index: NSE publishes no traded volume for an index, and Fyers
 * confirms it — `NSE:NIFTY50-INDEX` 5m bars report 0% non-zero volume through 2025 and
 * then 100% from 2026, a structural break that would make any volume-derived feature a
 * proxy for the calendar rather than for participation.
 *
 * Why not futures, for history: Fyers' history endpoint serves only currently listed
 * contracts. Every expired contract returns `-300 Invalid symbol`, so multi-year
 * futures history is unobtainable. (`cont_flag=1` appears to supply it, but it invents
 * bars for periods a contract never traded and back-adjusts the ones it did — see the
 * note in `fyers-historical-data-provider.ts`.) Futures remain the right instrument for
 * a record-forward series; they cannot supply a backfill.
 *
 * NIFTYBEES is measured at 100% non-zero volume on 1m and 5m back to at least
 * 2023-01, with median 5m volume around 25k-45k units. It tracks the index with
 * acknowledged tracking error and is genuinely tradable, which the index is not.
 *
 * BANKBEES is registered alongside it but is materially thinner — median 5m volume
 * around 2.4k — so its bars are far more likely to be dominated by microstructure
 * noise. Treat it as a candidate to be validated, not an equal of NIFTYBEES.
 *
 * Both are `is_active = FALSE`: research instruments only. Activating them for the
 * scanner or strategy engine is a separate, explicit decision, exactly as with the
 * twenty research equities in migration 027.
 */
export const etfIndexProxiesMigration: Migration = {
  id: "030-etf-index-proxies",
  sql: `
    INSERT INTO instruments (
      exchange, symbol, display_name, instrument_type, tick_size, lot_size, is_active, metadata
    ) VALUES
      (
        'NSE', 'NIFTYBEES', 'Nippon India ETF Nifty 50 BeES', 'ETF', 0.01, 1, FALSE,
        '{"market":"India","purpose":"tradable-index-proxy","tracks":"NIFTY50",
          "fyersSymbol":"NSE:NIFTYBEES-EQ","volumeVerified":"1m and 5m, 100% non-zero from 2023-01",
          "caveat":"tracking error against the index; not the index itself"}'::jsonb
      ),
      (
        'NSE', 'BANKBEES', 'Nippon India ETF Nifty Bank BeES', 'ETF', 0.01, 1, FALSE,
        '{"market":"India","purpose":"tradable-index-proxy","tracks":"BANKNIFTY",
          "fyersSymbol":"NSE:BANKBEES-EQ","volumeVerified":"5m, 100% non-zero from 2024-01",
          "caveat":"thin: median 5m volume near 2.4k units, an order of magnitude below NIFTYBEES"}'::jsonb
      )
    ON CONFLICT (exchange, symbol) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      instrument_type = EXCLUDED.instrument_type,
      tick_size = EXCLUDED.tick_size,
      metadata = instruments.metadata || EXCLUDED.metadata;
  `,
};
