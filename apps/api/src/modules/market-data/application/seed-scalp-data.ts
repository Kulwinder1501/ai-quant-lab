import type { DatabasePool } from "../../../infrastructure/database/database.js";
import {
  defaultMomentumScalpStrategyConfiguration,
  momentumScalpStrategyRegistration,
  momentumScalpStrategyVersion,
} from "../../strategy-engine/domain/momentum-scalp-strategy.js";

export async function seedScalpData(database: DatabasePool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    const stratRes = await client.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description, is_archived)
      VALUES ('momentum-scalp', $1, $2, FALSE)
      ON CONFLICT (strategy_key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [momentumScalpStrategyRegistration.name, momentumScalpStrategyRegistration.description]);
    const strategyId = stratRes.rows[0]?.id;
    if (!strategyId) throw new Error("Failed to insert/resolve strategy");

    // Register the same version and full configuration the strategy code declares,
    // rather than a `{"expiryCandles": 5}` stub that the momentum-scalp parser
    // rejects. An is_active strategy version whose configuration cannot be parsed
    // is a latent trap: anything that loads and parses the active version throws,
    // and it drifts from the version the generator's `ensure` actually creates.
    // Matching the registration keeps the seed and the code on one version, and
    // the config is jsonb-equal to what `ensure` writes, so it will not trip the
    // immutable-configuration guard.
    const verRes = await client.query<{ id: string }>(`
      INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
      VALUES ($1, $2, $3::jsonb, TRUE)
      ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
      RETURNING id
    `, [strategyId, momentumScalpStrategyVersion, JSON.stringify(defaultMomentumScalpStrategyConfiguration)]);
    if (!verRes.rows[0]?.id) throw new Error("Failed to insert/resolve strategy version");

    // No seeded candles, indicator snapshots, or trade_ideas rows.
    //
    // This seed used to fetch seven sessions of Yahoo 1m bars per index on every
    // boot, plus approximate 'v1' demo indicators over them. Two reasons both
    // writes are retired:
    //
    // 1. The 1m timeframe is Fyers-owned under the provider partition in
    //    collect-historical-data.ts. A boot-time Yahoo write would re-pollute the
    //    series after every `db:purge:yahoo-scalp`, recreating the exact mixed
    //    provenance the partition exists to prevent.
    // 2. Yahoo 1m bars for Indian indices carry zero volume, so every scalp
    //    feature depending on volume (VWAP included) was undefined over them.
    //
    // Real scalp series come from `data:collect:historical -- --provider fyers`,
    // and real indicators from `analysis:calculate-indicators`. Before that runs,
    // the scalp timeframes are honestly empty rather than plausibly wrong.
    //
    // A LONG+SHORT demo trade-idea pair was retired earlier for the same reason:
    // its ±0.1%/±0.2% geometry was fabricated and physically impossible under
    // MomentumScalpStrategy, which can never satisfy both sides on a single bar.

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
