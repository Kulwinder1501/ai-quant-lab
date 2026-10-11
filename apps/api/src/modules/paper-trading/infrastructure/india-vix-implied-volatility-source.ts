import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import { regimeSourceInstrumentSymbol } from "../../strategy-engine/domain/regime.js";
import { atmImpliedVolatility, calendarDaysToExpiry } from "../../market-data/domain/atm-implied-volatility.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import {
  selectStraddleImpliedVolatility,
  type StraddleImpliedVolatility,
} from "../domain/straddle-implied-volatility.js";

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
        AND c.close_time >= $2 - INTERVAL '7 days'
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

/** The slice of the option-chain repository the straddle IV needs. */
export interface ChainSnapshotReader {
  latestSnapshot(input: { underlyingSymbol: string; expiryDate?: string; asOf?: Date }): Promise<OptionChainSnapshot | null>;
}

/**
 * The straddle's implied volatility: the chain's own ATM IV at the contract's expiry when a
 * fresh point-in-time snapshot exists, India VIX only as a tagged fallback.
 *
 * `PostgresIndiaVixImpliedVolatilitySource` alone (a 30-day IV from yesterday's close) is the
 * wrong tenor and the wrong clock for pricing a ~7-day contract; see
 * `straddle-implied-volatility.ts`. Other consumers of that class are unchanged.
 */
export class ChainFirstStraddleImpliedVolatilitySource {
  constructor(
    private readonly chainReader: ChainSnapshotReader,
    private readonly vixSource: ImpliedVolatilitySource,
  ) {}

  async resolve(input: {
    underlyingSymbol: string;
    expiryDate: Date;
    asOf: Date;
  }): Promise<StraddleImpliedVolatility | null> {
    const snapshot = await this.chainReader.latestSnapshot({
      underlyingSymbol: input.underlyingSymbol,
      expiryDate: input.expiryDate.toISOString().slice(0, 10),
      asOf: input.asOf,
    }).catch(() => null);
    const chain = snapshot === null
      ? null
      : atmImpliedVolatility({
        observedAt: snapshot.observedAt,
        expiryDate: input.expiryDate,
        quotes: snapshot.quotes.filter((quote) => quote.expiryDate.getTime() === input.expiryDate.getTime()),
      });
    return selectStraddleImpliedVolatility({
      chain,
      chainObservedAt: snapshot?.observedAt ?? null,
      now: input.asOf,
      vix: await this.vixSource.resolveAsOf(input.asOf),
      daysToExpiry: calendarDaysToExpiry(input.asOf, input.expiryDate),
    });
  }
}

export class FixedImpliedVolatilitySource implements ImpliedVolatilitySource {
  constructor(private readonly value: number) {}
  async resolveAsOf(_asOf: Date): Promise<number | null> {
    return this.value;
  }
}
