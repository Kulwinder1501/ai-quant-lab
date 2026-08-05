import type { DatabasePool } from "../database.js";
import { fromDateColumn, toDateKey } from "../date-column.js";
import { yearsToExpiry } from "@ai-quant-lab/pricing";
import { impliedForwardFromParity } from "@ai-quant-lab/pricing";
import type { OptionExpiryCalendar } from "../../../modules/market-data/domain/option-expiry-calendar.js";
import type {
  ExpiryKind,
  OptionChainQuote,
  OptionChainSnapshot,
  OptionType,
} from "../../../modules/market-data/domain/option-chain.js";
import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

/**
 * The settlement instant for a DATE column holding an expiry: that day at 15:30 IST.
 *
 * `fromDateColumn` fixes the calendar day -- node-pg returns a DATE as *local* midnight, so
 * `row.expiry_date.toISOString().slice(0, 10)` gave 2026-08-24 for a stored 2026-08-25 on an
 * IST host. That surfaced as every chain expiry a day early and every IV and greek solved
 * against a tenor 15.5 hours short, and it read as correct inside the API container only
 * because that container runs UTC -- so the bug depended on where the code ran.
 *
 * The 10:00 UTC stamp then makes it the instant the contract actually settles, matching
 * `resolveOptionExpiryInstant` and the calendar rows.
 */
function toExpiryInstant(value: unknown): Date {
  const day = fromDateColumn(value);
  return new Date(day.getTime() + 10 * 60 * 60 * 1000);
}

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


  /**
   * The freshest observed quote for one exact contract, plus the parity forward for its
   * expiry.
   *
   * Both come from the SAME snapshot instant. Taking the newest quote and a forward from a
   * different observation would price a contract against a forward that never coexisted
   * with it, which is the subtler version of the carry error this exists to remove.
   *
   * Returns null when the contract is not in the latest snapshot at all, which is the
   * common case: collection covers a bounded strike window on a few underlyings, so most
   * positions still fall back to the model.
   */
  async latestContractQuote(input: {
    underlyingSymbol: string;
    expiryDate: Date;
    strikePrice: number;
    optionType: "CE" | "PE";
  }): Promise<{
    mid: number;
    bid: number | null;
    ask: number | null;
    observedAt: Date;
    impliedForward: number | null;
  } | null> {
    const expiryKey = input.expiryDate.toISOString().slice(0, 10);
    const latest = await this.pool.query(`
      SELECT max(observed_at) AS observed_at
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1 AND expiry_date = $2::date
    `, [input.underlyingSymbol, expiryKey]);
    const observedAt = latest.rows[0]?.observed_at as Date | null | undefined;
    if (!observedAt) return null;

    const rows = await this.pool.query(`
      SELECT strike_price, option_type, bid, ask
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1 AND expiry_date = $2::date AND observed_at = $3
    `, [input.underlyingSymbol, expiryKey, observedAt]);
    if (rows.rows.length === 0) return null;

    const midOf = (bid: unknown, ask: unknown): number | null => {
      const b = toNumberOrNull(bid);
      const a = toNumberOrNull(ask);
      // A one-sided market has no mid. Substituting the quoted side would mark the
      // position at a price nobody was prepared to take the other half of.
      if (b === null || a === null || b <= 0 || a <= 0 || a < b) return null;
      return (b + a) / 2;
    };

    let target: { mid: number; bid: number | null; ask: number | null } | null = null;
    const pairs = new Map<number, { callMid?: number; putMid?: number }>();
    for (const row of rows.rows) {
      const strike = Number(row.strike_price);
      const optionType = String(row.option_type) as "CE" | "PE";
      const mid = midOf(row.bid, row.ask);
      if (mid !== null) {
        const slot = pairs.get(strike) ?? {};
        if (optionType === "CE") slot.callMid = mid;
        else slot.putMid = mid;
        pairs.set(strike, slot);
      }
      if (strike === input.strikePrice && optionType === input.optionType && mid !== null) {
        target = { mid, bid: toNumberOrNull(row.bid), ask: toNumberOrNull(row.ask) };
      }
    }
    if (target === null) return null;

    const timeToExpiry = yearsToExpiry(observedAt, input.expiryDate);
    const impliedForward = impliedForwardFromParity(
      [...pairs.entries()]
        .filter(([, slot]) => slot.callMid !== undefined && slot.putMid !== undefined)
        .map(([strike, slot]) => ({ strike, callMid: slot.callMid!, putMid: slot.putMid! })),
      RISK_FREE_RATE,
      timeToExpiry,
    );

    return { ...target, observedAt, impliedForward };
  }

  /** Persists one observation of which contracts an underlying lists. */
  async saveExpiryCalendar(calendar: OptionExpiryCalendar): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const entry of calendar.expiries) {
      const result = await this.pool.query(`
        INSERT INTO option_expiry_calendar (
          underlying_symbol, provider, observed_at, expiry_date, expiry_kind
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (underlying_symbol, observed_at, expiry_date) DO NOTHING
      `, [
        calendar.underlyingSymbol,
        calendar.provider,
        calendar.observedAt,
        entry.expiryDate,
        entry.expiryKind,
      ]);
      inserted += result.rowCount ?? 0;
    }
    return { inserted };
  }

  /**
   * The newest observed expiry list for one underlying.
   *
   * Scoped to a single `observed_at`, like `latestSnapshot`: a union across observations
   * would report a calendar that never existed at any instant, and the whole point of this
   * lookup is to answer "does this contract trade?" from something that was actually seen.
   */
  async latestExpiryCalendar(underlyingSymbol: string): Promise<OptionExpiryCalendar | null> {
    const result = await this.pool.query(`
      SELECT provider, observed_at, expiry_date, expiry_kind
      FROM option_expiry_calendar
      WHERE underlying_symbol = $1
        AND observed_at = (
          SELECT max(observed_at) FROM option_expiry_calendar WHERE underlying_symbol = $1
        )
      ORDER BY expiry_date
    `, [underlyingSymbol]);
    if (result.rows.length === 0) return null;

    return {
      underlyingSymbol,
      provider: String(result.rows[0].provider),
      observedAt: result.rows[0].observed_at as Date,
      expiries: result.rows.map((row) => ({
        // DATE comes back at midnight; the contract settles at 15:30 IST.
        expiryDate: toExpiryInstant(row.expiry_date),
        expiryKind: String(row.expiry_kind) as ExpiryKind,
      })),
    };
  }

  /**
   * One ATM-ish implied-volatility input per stored day, for the IV percentile.
   *
   * Returns the *last* snapshot of each day, and only the strikes adjacent to that snapshot's
   * own spot, so the caller solves a handful of contracts per day rather than every strike of
   * every 15-minute observation. A percentile needs one value per day: intraday snapshots are
   * autocorrelated, so ranking against all of them would let two sessions look like fifty
   * independent samples.
   */
  async dailyAtmQuotes(input: { underlyingSymbol: string; days: number }): Promise<Array<{
    date: string;
    observedAt: Date;
    underlyingValue: number | null;
    expiryDate: Date;
    strikePrice: number;
    optionType: OptionType;
    bid: number | null;
    ask: number | null;
  }>> {
    const result = await this.pool.query(`
      WITH last_per_day AS (
        SELECT DISTINCT ON ((observed_at AT TIME ZONE 'Asia/Kolkata')::date)
               (observed_at AT TIME ZONE 'Asia/Kolkata')::date AS session_date,
               observed_at
        FROM option_chain_snapshots
        WHERE underlying_symbol = $1
        ORDER BY (observed_at AT TIME ZONE 'Asia/Kolkata')::date DESC, observed_at DESC
      ),
      recent AS (SELECT * FROM last_per_day ORDER BY session_date DESC LIMIT $2)
      SELECT r.session_date, s.observed_at, s.underlying_value, s.expiry_date,
             s.strike_price, s.option_type, s.bid, s.ask
      FROM recent r
      JOIN option_chain_snapshots s
        ON s.underlying_symbol = $1 AND s.observed_at = r.observed_at
      -- Nearest expiry only: mixing tenors would rank today's front-month IV against a
      -- previous day's far-month, which is a different quantity.
      WHERE s.expiry_date = (
        SELECT min(expiry_date) FROM option_chain_snapshots inner_s
        WHERE inner_s.underlying_symbol = $1 AND inner_s.observed_at = r.observed_at
      )
      ORDER BY r.session_date DESC, s.strike_price, s.option_type
    `, [input.underlyingSymbol, Math.max(1, Math.floor(input.days))]);

    return result.rows.map((row) => ({
      date: toDateKey(fromDateColumn(row.session_date)),
      observedAt: row.observed_at as Date,
      underlyingValue: toNumberOrNull(row.underlying_value),
      expiryDate: toExpiryInstant(row.expiry_date),
      strikePrice: Number(row.strike_price),
      optionType: String(row.option_type) as OptionType,
      bid: toNumberOrNull(row.bid),
      ask: toNumberOrNull(row.ask),
    }));
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
      expiryDate: toExpiryInstant(row.expiry_date),
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

    // The calendar written by the same collection, matched on the same instant. Empty for
    // snapshots taken before the calendar table existed; a reader must not mistake that for
    // "this underlying lists nothing", which is why `resolveListedExpiry` treats an empty
    // list as "no calendar" rather than as a refusal of every contract.
    const calendarRows = await this.pool.query(`
      SELECT expiry_date, expiry_kind
      FROM option_expiry_calendar
      WHERE underlying_symbol = $1 AND observed_at = $2
      ORDER BY expiry_date
    `, [input.underlyingSymbol, observedAt]);

    return {
      underlyingSymbol: input.underlyingSymbol,
      provider: String(result.rows[0].provider),
      observedAt,
      underlyingValue: toNumberOrNull(result.rows[0].underlying_value),
      quotes,
      listedExpiries: calendarRows.rows.map((row) => ({
        expiryDate: toExpiryInstant(row.expiry_date),
        expiryKind: String(row.expiry_kind) as ExpiryKind,
      })),
    };
  }
}
