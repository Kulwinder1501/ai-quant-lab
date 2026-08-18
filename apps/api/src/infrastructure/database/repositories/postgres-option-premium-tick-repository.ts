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
  /**
   * The reported volume when it was rejected as impossible, otherwise null.
   *
   * Never set at the same time as `volume`. See `normaliseTradedVolume`: a negative cumulative count
   * is a wrapped counter, and it is recorded rather than repaired or thrown away.
   */
  volumeRaw: number | null;
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
    // Read back unchanged. A reader that silently substituted the rejected figure for the trusted one
    // would undo the whole point of keeping them apart.
    volumeRaw: row.volume_raw === null || row.volume_raw === undefined ? null : Number(row.volume_raw),
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
          provider_symbol, last_price, bid, ask, volume, underlying_value, volume_raw
        ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
          tick.volumeRaw,
        ],
      );
      if ((result.rowCount ?? 0) > 0) inserted += 1;
      else skipped += 1;
    }
    return { inserted, skipped };
  }

  /**
   * Latest tick for one provider contract as at `now`, or null if none / older than maxAgeMs.
   *
   * Bounded by `observed_at <= now` like the other two readers. This one never had the
   * negative-age bug, but it also had no point-in-time bound at all, so a caller passing a
   * historical `now` could be handed a quote from after it.
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
        AND observed_at <= $2
      ORDER BY observed_at DESC
      LIMIT 1
      `,
      [providerSymbol, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    if (now.getTime() - observedAt.getTime() > maxAgeMs) return null;
    return toTick(row);
  }

  /**
   * Latest dense observation for an exact listed contract, as at `now`.
   *
   * Consumers address positions by their persisted contract fields, not by a provider symbol
   * that was never stored on `paper_trades`. Keeping that translation here lets valuation and
   * stop evaluation use the dense series without guessing Fyers' symbol spelling.
   *
   * `observed_at <= now` is applied **in SQL, before `LIMIT 1`**, and that ordering is the whole
   * point. This previously took the newest row outright and then rejected it when
   * `now - observed_at` came out negative, which threw the lookup away instead of falling back
   * to the newest row the caller was actually entitled to see. Callers capture `now` and then
   * do work before querying, while the collector writes twice a minute, so a sample landing in
   * that gap is routine rather than exceptional -- and the result was a null that reads as "no
   * quote exists" for a contract being quoted continuously.
   *
   * Measured on the AutoBot account 2026-08-13: the bot claimed its run at 06:55:00.019 and a
   * BANKNIFTY 57700 CE tick was written at 06:55:00.696, so the only candidate row was 676ms
   * "in the future". The lookup returned null, the caller fell back to a theoretical premium,
   * and the position was booked STOP_LOSS at 519.58 while the book was bid 576-581 -- above its
   * own target. Filtering first returns the 06:54:26 tick (bid 577.45, 34s old and well inside
   * the window), which is the correct point-in-time answer.
   *
   * Filtering rather than widening the window to accept future rows is deliberate: a caller
   * replaying a historical `now` must not be handed a quote from after it, which is the
   * lookahead the old negative-age check was reaching for. This keeps that guarantee and
   * stops it from discarding good data.
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
        AND observed_at <= $5
      ORDER BY observed_at DESC
      LIMIT 1
    `, [
      contract.underlyingSymbol.toUpperCase(),
      contract.expiryDate.toISOString().slice(0, 10),
      contract.strikePrice,
      contract.optionType,
      now,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    // Only staleness remains to check: the query has already excluded anything after `now`.
    if (now.getTime() - observedAt.getTime() > maxAgeMs) return null;
    return toTick(row);
  }

  /**
   * Every observed tick for one contract in `(after, to]`, oldest first.
   *
   * This is what lets a barrier be tested against **prices that were actually quoted** instead of
   * a premium the model imagined. A point-in-time reader cannot answer "did the stop trade at any
   * moment between two evaluations?" -- it only sees the latest sample -- and the alternative,
   * repricing the underlying's OHLC through Black-Scholes, was measured wrong by more than the
   * barrier distance it was resolving (see `latestForContract`).
   *
   * `after` is **exclusive** so the sample a position was opened on cannot immediately close it,
   * matching `decidePaperTradeExit`'s convention of skipping the source bar. `to` is inclusive and
   * bounds the read to the caller's as-of, so a replay cannot see past its own clock.
   *
   * Deliberately uncapped. A contract collected at roughly two samples a minute yields ~780 rows
   * over a full session, which is a small read; a `LIMIT` here would silently drop the oldest
   * crossings and report the wrong exit time rather than failing.
   */
  async listForContractBetween(
    contract: OptionPremiumContractKey,
    after: Date,
    to: Date,
  ): Promise<OptionPremiumTickRow[]> {
    const result = await this.pool.query(`
      SELECT underlying_symbol, provider, observed_at, expiry_date::text AS expiry_date,
             strike_price, option_type, provider_symbol, last_price, bid, ask, volume,
             underlying_value
      FROM option_premium_ticks
      WHERE underlying_symbol = $1
        AND expiry_date = $2::date
        AND strike_price = $3
        AND option_type = $4
        AND observed_at > $5
        AND observed_at <= $6
      ORDER BY observed_at ASC
    `, [
      contract.underlyingSymbol.toUpperCase(),
      contract.expiryDate.toISOString().slice(0, 10),
      contract.strikePrice,
      contract.optionType,
      after,
      to,
    ]);
    return (result.rows as Array<Record<string, unknown>>).map(toTick);
  }

  /**
   * Fresh underlying print captured in the same provider response as the dense option book.
   *
   * Filters to `observed_at <= now` in SQL for the same reason as `latestForContract`: taking the
   * newest row and then rejecting a negative age discarded the lookup whenever a tick landed
   * between the caller capturing `now` and running the query.
   */
  async latestUnderlyingValue(
    underlyingSymbol: string,
    maxAgeMs = 2 * 60 * 1000,
    now = new Date(),
  ): Promise<{ value: number; observedAt: Date } | null> {
    const result = await this.pool.query(`
      SELECT observed_at, underlying_value
      FROM option_premium_ticks
      WHERE underlying_symbol = $1 AND underlying_value > 0
        AND observed_at <= $2
      ORDER BY observed_at DESC
      LIMIT 1
    `, [underlyingSymbol.toUpperCase(), now]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const observedAt = row.observed_at as Date;
    const value = Number(row.underlying_value);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (now.getTime() - observedAt.getTime() > maxAgeMs) return null;
    return { value, observedAt };
  }
}
