/**
 * What `candles.source` and `candles.source_metadata` mean.
 *
 * `source` records the **provider the prices came from** — the ingestion paths set it
 * from `provider.id`, so it answers "can I trust these numbers, and who published
 * them". `source_metadata` records **how the row got here**.
 *
 * The seeds used to conflate the two, hardcoding `source = 'seed'` for candles they
 * had just fetched from Yahoo. That labelled real provider data as though its origin
 * were a fixture, and left 4374 rows on which the column that exists to identify real
 * market data instead identified the script that wrote it.
 */

export const YAHOO_PROVIDER_ID = "yahoo";

/** `source_metadata` for a row written by a seed run, whatever its provider. */
export const SEED_SOURCE_METADATA = JSON.stringify({ ingestedBy: "seed" });
