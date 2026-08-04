import type { DatabasePool } from "../database.js";
import type {
  ExpiryKind,
  OptionChainQuote,
  OptionChainSnapshot,
  OptionType,
} from "../../../modules/market-data/domain/option-chain.js";

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresOptionChainRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Persists one snapshot's contracts in a single transaction.
   *
   * `ON CONFLICT DO NOTHING` on the identity index makes a re-run inside the same
   * observation idempotent rather than doubling the book. It deliberately does not
   * update: a snapshot records what was observed at that instant, so a second read is
   * either the same book or a different observation carrying its own timestamp.
   */
  async saveSnapshot(snapshot: OptionChainSnapshot): Promise<{ inserted: number; skipped: number }> {
    const client = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      for (const quote of snapshot.quotes) {
        const result = await client.query(`
          INSERT INTO option_chain_snapshots (
            underlying_symbol, provider, observed_at, expiry_date, expiry_kind,
            strike_price, option_type, provider_symbol, provider_token,
            last_price, bid, ask, volume, open_interest, previous_open_interest,
            open_interest_change, underlying_value
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (underlying_symbol, observed_at, expiry_date, strike_price, option_type)
          DO NOTHING
        `, [
          snapshot.underlyingSymbol,
          snapshot.provider,
          snapshot.observedAt,
          quote.expiryDate,
          quote.expiryKind,
          quote.strikePrice,
          quote.optionType,
          quote.providerSymbol,
          quote.providerToken,
          quote.lastPrice,
          quote.bid,
          quote.ask,
          quote.volume,
          quote.openInterest,
          quote.previousOpenInterest,
          quote.openInterestChange,
          snapshot.underlyingValue,
        ]);
        inserted += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { inserted, skipped: snapshot.quotes.length - inserted };
  }

  /** Distinct underlyings with a stored chain, and how fresh each is. */
  async listUnderlyings(): Promise<Array<{
    underlyingSymbol: string;
    latestObservedAt: Date;
    snapshotCount: number;
    expiries: string[];
  }>> {
    const result = await this.pool.query(`
      SELECT underlying_symbol,
             max(observed_at)            AS latest_observed_at,
             count(DISTINCT observed_at) AS snapshot_count,
             array_agg(DISTINCT expiry_date::text) AS expiries
      FROM option_chain_snapshots
      GROUP BY underlying_symbol
      ORDER BY underlying_symbol
    `);
    return result.rows.map((row) => ({
      underlyingSymbol: String(row.underlying_symbol),
      latestObservedAt: row.latest_observed_at as Date,
      snapshotCount: Number(row.snapshot_count),
      expiries: ((row.expiries as string[]) ?? []).slice().sort(),
    }));
  }

  /**
   * The most recent stored chain for one underlying, optionally for one expiry.
   *
   * Scoped to a single `observed_at` so the returned book is one coherent observation.
   * Taking the newest row per contract instead would blend instants and produce a chain
   * that never existed at any moment.
   */
  async latestSnapshot(input: {
    underlyingSymbol: string;
    expiryDate?: string;
  }): Promise<OptionChainSnapshot | null> {
    const latest = await this.pool.query(`
      SELECT max(observed_at) AS observed_at
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1
        AND ($2::date IS NULL OR expiry_date = $2::date)
    `, [input.underlyingSymbol, input.expiryDate ?? null]);
    const observedAt = latest.rows[0]?.observed_at as Date | null | undefined;
    if (!observedAt) return null;

    const result = await this.pool.query(`
      SELECT provider, expiry_date, expiry_kind, strike_price, option_type, provider_symbol,
             provider_token, last_price, bid, ask, volume, open_interest,
             previous_open_interest, open_interest_change, underlying_value
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1 AND observed_at = $2
        AND ($3::date IS NULL OR expiry_date = $3::date)
      ORDER BY expiry_date, strike_price, option_type
    `, [input.underlyingSymbol, observedAt, input.expiryDate ?? null]);
    if (result.rows.length === 0) return null;

    const quotes: OptionChainQuote[] = result.rows.map((row) => ({
      expiryDate: row.expiry_date as Date,
      expiryKind: String(row.expiry_kind) as ExpiryKind,
      strikePrice: Number(row.strike_price),
      optionType: String(row.option_type) as OptionType,
      providerSymbol: String(row.provider_symbol),
      providerToken: row.provider_token === null ? null : String(row.provider_token),
      lastPrice: toNumberOrNull(row.last_price),
      bid: toNumberOrNull(row.bid),
      ask: toNumberOrNull(row.ask),
      volume: toNumberOrNull(row.volume),
      openInterest: toNumberOrNull(row.open_interest),
      previousOpenInterest: toNumberOrNull(row.previous_open_interest),
      openInterestChange: toNumberOrNull(row.open_interest_change),
    }));

    return {
      underlyingSymbol: input.underlyingSymbol,
      provider: String(result.rows[0].provider),
      observedAt,
      underlyingValue: toNumberOrNull(result.rows[0].underlying_value),
      quotes,
    };
  }
}
