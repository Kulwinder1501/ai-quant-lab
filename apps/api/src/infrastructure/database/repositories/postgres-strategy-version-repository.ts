import type { QueryResultRow } from "pg";
import type {
  EnsureStrategyVersionInput,
  StrategyVersion,
  StrategyVersionRepository,
} from "../../../modules/strategy-engine/domain/strategy.js";
import type { DatabaseQueryable } from "../database.js";

interface StrategyVersionRow extends QueryResultRow {
  id: string;
  strategy_id: string;
  strategy_key: string;
  name: string;
  description: string;
  version: number;
  configuration: Record<string, unknown>;
  is_active: boolean;
  is_archived: boolean;
  configuration_matches?: boolean;
}

const returningColumns = `
  strategy_versions.id,
  strategy_versions.strategy_id,
  strategies.strategy_key,
  strategies.name,
  strategies.description,
  strategy_versions.version,
  strategy_versions.configuration,
  strategy_versions.is_active,
  strategies.is_archived
`;

function toStrategyVersion(row: StrategyVersionRow): StrategyVersion {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyKey: row.strategy_key,
    name: row.name,
    description: row.description,
    version: row.version,
    configuration: row.configuration,
    isActive: row.is_active,
    isArchived: row.is_archived,
  };
}

function serializeConfiguration(configuration: Record<string, unknown>): string {
  const serialized = JSON.stringify(configuration);
  if (!serialized || !serialized.startsWith("{")) {
    throw new Error("Strategy configuration must be a JSON object.");
  }
  return serialized;
}

/**
 * Strategy metadata can be refreshed, but a strategy-version configuration is
 * immutable. A changed rule set must be registered under a new version number.
 */
export class PostgresStrategyVersionRepository implements StrategyVersionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async ensure(input: EnsureStrategyVersionInput): Promise<StrategyVersion> {
    const configuration = serializeConfiguration(input.configuration);
    const strategy = await this.database.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description)
      VALUES ($1, $2, $3)
      ON CONFLICT (strategy_key) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description
      RETURNING id
    `, [input.strategyKey, input.name, input.description]);
    const strategyId = strategy.rows[0]?.id;
    if (!strategyId) {
      throw new Error(`Unable to resolve strategy ${input.strategyKey}.`);
    }

    await this.database.query(`
      INSERT INTO strategy_versions (strategy_id, version, configuration)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (strategy_id, version) DO NOTHING
    `, [strategyId, input.version, configuration]);

    const resolved = await this.database.query<StrategyVersionRow>(`
      SELECT
        ${returningColumns},
        strategy_versions.configuration = $3::jsonb AS configuration_matches
      FROM strategy_versions
      INNER JOIN strategies ON strategies.id = strategy_versions.strategy_id
      WHERE strategy_versions.strategy_id = $1 AND strategy_versions.version = $2
    `, [strategyId, input.version, configuration]);
    const existing = resolved.rows[0];
    if (!existing) {
      throw new Error(`Unable to resolve strategy version ${input.strategyKey}@${input.version}.`);
    }
    if (!existing.configuration_matches) {
      throw new Error(
        `Strategy version ${input.strategyKey}@${input.version} already exists with a different immutable configuration.`,
      );
    }

    /*
     * Exactly one active version per strategy, and it is the one the code declares.
     *
     * `is_active` defaults to TRUE and this method never set it, so every version bump left its
     * predecessor active -- momentum-scalp reached 2 and 3, trend-breakout 1 and 2. The generator
     * was unaffected because it resolves by `(strategy_id, version)`, but the callers that ask the
     * database to nominate "the" active version were choosing arbitrarily between them.
     *
     * Gated on actual drift rather than run unconditionally: this is called for every strategy on
     * every generation pass, and the two-step update below passes briefly through zero active rows.
     * A concurrent reader inside that window would see the strategy as inactive and skip it once,
     * reported as STRATEGY_INACTIVE. Doing the write only when the state is wrong confines that
     * window to a genuine version bump instead of opening it on every pass.
     *
     * Deactivate-then-activate, in that order. The reverse would hold two active rows for an instant
     * and violate 097's partial unique index; zero is permitted by it.
     */
    const drift = await this.database.query<{ stale: string }>(`
      SELECT count(*)::text AS stale
      FROM strategy_versions
      WHERE strategy_id = $1 AND is_active AND version <> $2
    `, [strategyId, input.version]);
    if (Number(drift.rows[0]?.stale ?? "0") > 0 || !existing.is_active) {
      await this.database.query(`
        UPDATE strategy_versions SET is_active = FALSE
        WHERE strategy_id = $1 AND version <> $2 AND is_active
      `, [strategyId, input.version]);
      await this.database.query(`
        UPDATE strategy_versions SET is_active = TRUE
        WHERE strategy_id = $1 AND version = $2 AND NOT is_active
      `, [strategyId, input.version]);
    }


    return toStrategyVersion(existing);
  }
}
