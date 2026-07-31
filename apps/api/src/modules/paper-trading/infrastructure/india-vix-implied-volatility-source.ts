import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import { regimeSourceInstrumentSymbol } from "../../strategy-engine/domain/regime.js";

/**
 * Resolves a point-in-time implied vol from settled India VIX daily closes.
 * Values are returned as decimals (12.5 → 0.125).
 */
export interface ImpliedVolatilitySource {
  resolveAsOf(asOf: Date): Promise<number | null>;
}

export class PostgresIndiaVixImpliedVolatilitySource implements ImpliedVolatilitySource {
  constructor(private readonly database: DatabaseQueryable) {}

  async resolveAsOf(asOf: Date): Promise<number | null> {
    const result = await this.database.query(`
      SELECT c.close
      FROM candles c
      INNER JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1
        AND c.timeframe = '1d'
        AND c.is_complete = TRUE
        AND c.close_time <= $2
      ORDER BY c.close_time DESC
      LIMIT 1
    `, [regimeSourceInstrumentSymbol, asOf]);
    const row = result.rows[0] as { close: string } | undefined;
    if (!row) return null;
    const raw = Number(row.close);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1 ? raw / 100 : raw;
  }
}

export class FixedImpliedVolatilitySource implements ImpliedVolatilitySource {
  constructor(private readonly value: number) {}
  async resolveAsOf(_asOf: Date): Promise<number | null> {
    return this.value;
  }
}
