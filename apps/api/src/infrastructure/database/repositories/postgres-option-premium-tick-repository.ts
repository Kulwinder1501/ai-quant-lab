import type { DatabasePool } from "../database.js";

export interface OptionPremiumTickRow {
  underlyingSymbol: string;
  provider: string;
  observedAt: Date;
  expiryDate: string;
  strikePrice: number;
  optionType: "CE" | "PE";
  providerSymbol: string;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  underlyingValue: number | null;
}

export interface OptionPremiumContractKey {
  underlyingSymbol: string;
  expiryDate: Date;
  strikePrice: number;
  optionType: "CE" | "PE";
}

function toTick(row: Record<string, unknown>): OptionPremiumTickRow {
  return {
    underlyingSymbol: String(row.underlying_symbol),
    provider: String(row.provider),
    observedAt: row.observed_at as Date,
    expiryDate: String(row.expiry_date).slice(0, 10),
    strikePrice: Number(row.strike_price),
    optionType: String(row.option_type) as "CE" | "PE",
    providerSymbol: String(row.provider_symbol),
    lastPrice: row.last_price === null ? null : Number(row.last_price),
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
    volume: row.volume === null ? null : Number(row.volume),
    underlyingValue: row.underlying_value === null ? null : Number(row.underlying_value),
  };
}

export class PostgresOptionPremiumTickRepository {
  constructor(private readonly pool: DatabasePool) {}

  async insertTicks(ticks: readonly OptionPremiumTickRow[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const tick of ticks) {
      const result = await this.pool.query(
        `
        INSERT INTO option_premium_ticks (
          underlying_symbol, provider, observed_at, expiry_date, strike_price, option_type,
          provider_symbol, last_price, bid, ask, volume, underlying_value
        ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (underlying_symbol, observed_at, expiry_date, strike_price, option_type)
        DO NOTHING
        `,
        [
          tick.underlyingSymbol,
          tick.provider,
          tick.observedAt,
          tick.expiryDate,
          tick.strikePrice,
          tick.optionType,
          tick.providerSymbol,
          tick.lastPrice,
          tick.bid,
          tick.ask,
          tick.volume,
          tick.underlyingValue,
        ],
      );
      if ((result.rowCount ?? 0) > 0) inserted += 1;
      else skipped += 1;
    }
    return { inserted, skipped };
  }

  /**
   * Latest tick for one provider contract, or null if none / older than maxAgeMs.
   */
  async latestForProviderSymbol(
    providerSymbol: string,
    maxAgeMs = 2 * 60 * 1000,
    now = new Date(),
  ): Promise<OptionPremiumTickRow | null> {
    const result = await this.pool.query(
      `
      SELECT underlying_symbol, provider, observed_at, expiry_date::text AS expiry_date,
             strike_price, option_type, provider_symbol, last_price, bid, ask, volume,
             underlying_value
      FROM option_premium_ticks
      WHERE provider_symbol = $1
      ORDER BY observed_at DESC
      LIMIT 1
      `,
      [providerSymbol],
    );
    const row = result.rows[0];
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    if (now.getTime() - observedAt.getTime() > maxAgeMs) return null;
    return toTick(row);
  }

  /**
   * Latest dense observation for an exact listed contract.
   *
   * Consumers address positions by their persisted contract fields, not by a provider symbol
   * that was never stored on `paper_trades`. Keeping that translation here lets valuation and
   * stop evaluation use the dense series without guessing Fyers' symbol spelling.
   */
  async latestForContract(
    contract: OptionPremiumContractKey,
    maxAgeMs = 2 * 60 * 1000,
    now = new Date(),
  ): Promise<OptionPremiumTickRow | null> {
    const result = await this.pool.query(`
      SELECT underlying_symbol, provider, observed_at, expiry_date::text AS expiry_date,
             strike_price, option_type, provider_symbol, last_price, bid, ask, volume,
             underlying_value
      FROM option_premium_ticks
      WHERE underlying_symbol = $1
        AND expiry_date = $2::date
        AND strike_price = $3
        AND option_type = $4
      ORDER BY observed_at DESC
      LIMIT 1
    `, [
      contract.underlyingSymbol.toUpperCase(),
      contract.expiryDate.toISOString().slice(0, 10),
      contract.strikePrice,
      contract.optionType,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    const ageMs = now.getTime() - observedAt.getTime();
    if (ageMs < 0 || ageMs > maxAgeMs) return null;
    return toTick(row);
  }

  /** Fresh underlying print captured in the same provider response as the dense option book. */
  async latestUnderlyingValue(
    underlyingSymbol: string,
    maxAgeMs = 2 * 60 * 1000,
    now = new Date(),
  ): Promise<{ value: number; observedAt: Date } | null> {
    const result = await this.pool.query(`
      SELECT observed_at, underlying_value
      FROM option_premium_ticks
      WHERE underlying_symbol = $1 AND underlying_value > 0
      ORDER BY observed_at DESC
      LIMIT 1
    `, [underlyingSymbol.toUpperCase()]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    const value = Number(row.underlying_value);
    const ageMs = now.getTime() - observedAt.getTime();
    if (!Number.isFinite(value) || value <= 0 || ageMs < 0 || ageMs > maxAgeMs) return null;
    return { value, observedAt };
  }
}
