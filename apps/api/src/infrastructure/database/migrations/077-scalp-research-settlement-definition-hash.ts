import type { Migration } from "../migration-runner.js";

/**
 * Persists the settlement policy's frozen definition hash alongside its version.
 *
 * FILL_POLICY_V1 requires that a fill-semantics change bump `settlementPolicyVersion`. That rule was
 * enforced by nobody: the version is a bare string, so an edited component would silently reuse it and
 * older rows would become incomparable to newer ones while still claiming the same policy. Adding the
 * component version to the identity key would be the wrong repair — two definitions would then coexist
 * as two keys instead of colliding, which is exactly the failure the payload-hash conflict check exists
 * to prevent.
 *
 * Storing the hash instead binds version to definition *structurally*: the same version resolving to a
 * second distinct hash is a `POLICY_DETERMINISM_VIOLATION`, detectable across all stored rows by the
 * acceptance audit rather than only when a subject happens to be re-settled.
 *
 * Nullable, because rows written before this migration cannot be retro-attributed to a definition hash
 * without asserting something about them that was never recorded. The audit counts distinct non-null
 * hashes per version, so a legacy NULL neither triggers nor masks a violation.
 */
export const scalpResearchSettlementDefinitionHashMigration: Migration = {
  id: "077-scalp-research-settlement-definition-hash",
  sql: `
    ALTER TABLE research_scalp.terminal_settlements
      ADD COLUMN IF NOT EXISTS settlement_definition_hash CHAR(64);
    ALTER TABLE research_scalp.settlement_observations
      ADD COLUMN IF NOT EXISTS settlement_definition_hash CHAR(64);

    ALTER TABLE research_scalp.terminal_settlements
      DROP CONSTRAINT IF EXISTS terminal_settlements_definition_hash_format;
    ALTER TABLE research_scalp.terminal_settlements
      ADD CONSTRAINT terminal_settlements_definition_hash_format
        CHECK (settlement_definition_hash IS NULL OR settlement_definition_hash ~ '^[0-9a-f]{64}$');

    ALTER TABLE research_scalp.settlement_observations
      DROP CONSTRAINT IF EXISTS settlement_observations_definition_hash_format;
    ALTER TABLE research_scalp.settlement_observations
      ADD CONSTRAINT settlement_observations_definition_hash_format
        CHECK (settlement_definition_hash IS NULL OR settlement_definition_hash ~ '^[0-9a-f]{64}$');

    CREATE INDEX IF NOT EXISTS research_scalp_terminal_policy_definition_idx
      ON research_scalp.terminal_settlements (settlement_policy_version, settlement_definition_hash);
  `,
};
