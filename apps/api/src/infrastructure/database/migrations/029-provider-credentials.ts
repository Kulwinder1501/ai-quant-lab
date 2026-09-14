import type { Migration } from "../migration-runner.js";

/**
 * Phase 23 reserved this table as `028-provider-credentials`, but `028` was taken by
 * `028-market-context-integrity` before the Fyers work started. Renumbered to `029`;
 * the purge that follows it moved from `029` to `030` for the same reason.
 *
 * One row per provider, keyed by the same ID written into `candles.source`. Token
 * columns are nullable so an un-authenticated row can exist and carry `last_error`
 * rather than the row being absent.
 *
 * This table holds live broker secrets in plaintext. That is acceptable for a local
 * single-operator lab and is not acceptable on a hosted or shared database.
 */
export const providerCredentialsMigration: Migration = {
  id: "029-provider-credentials",
  sql: `
    CREATE TABLE IF NOT EXISTS provider_credentials (
      provider TEXT PRIMARY KEY CHECK (length(trim(provider)) > 0),
      access_token TEXT,
      access_token_expires_at TIMESTAMPTZ,
      refresh_token TEXT,
      refresh_token_expires_at TIMESTAMPTZ,
      last_refreshed_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    COMMENT ON TABLE provider_credentials IS
      'Broker API tokens, one row per provider ID as used in candles.source. Plaintext: local single-operator use only.';
    COMMENT ON COLUMN provider_credentials.last_error IS
      'Most recent auth failure, with any token value redacted before storage.';
  `,
};
