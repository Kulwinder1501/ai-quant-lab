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
import type { VendorGreeks } from "../../../modules/market-data/domain/vendor-greeks.js";
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

/**
 * The provider's stored Greeks for one row, or null when none were observed.
 *
 * All five NULL (a row from before migration 142, an underlying the provider sends no Greeks for) reads
 * as `null`, "not observed", rather than as an object of nulls: callers branch on the one, and an
 * object of nulls would invite treating absence as data. Exported for the test.
 */
export function vendorGreeksFromRow(row: Record<string, unknown>): VendorGreeks | null {
  const greeks: VendorGreeks = {
    delta: toNumberOrNull(row.vendor_delta),
    gamma: toNumberOrNull(row.vendor_gamma),
    theta: toNumberOrNull(row.vendor_theta),
    vega: toNumberOrNull(row.vendor_vega),
    impliedVolatilityPercent: toNumberOrNull(row.vendor_iv_percent),
  };
  return Object.values(greeks).some((value) => value !== null) ? greeks : null;
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
            open_interest_change, underlying_value,
            vendor_delta, vendor_gamma, vendor_theta, vendor_vega, vendor_iv_percent
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
          // NULL when the provider sent none (older rows, an underlying without Greeks, a value that
          // failed the range check): "not observed", never zero.
          quote.vendorGreeks?.delta ?? null,
          quote.vendorGreeks?.gamma ?? null,
          quote.vendorGreeks?.theta ?? null,
          quote.vendorGreeks?.vega ?? null,
          quote.vendorGreeks?.impliedVolatilityPercent ?? null,
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
    /** The index level in the snapshot this quote came from. */
    underlyingValue: number | null;
    /** The contract's last traded price in that snapshot. */
    lastPrice: number | null;
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
      SELECT strike_price, option_type, bid, ask, underlying_value, last_price
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

    let target: {
      mid: number;
      bid: number | null;
      ask: number | null;
      underlyingValue: number | null;
      lastPrice: number | null;
    } | null = null;
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
        target = { mid, bid: toNumberOrNull(row.bid), ask: toNumberOrNull(row.ask), underlyingValue: toNumberOrNull(row.underlying_value), lastPrice: toNumberOrNull(row.last_price) };
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

  /**
   * The provider symbol of one exact contract, from its latest stored snapshot. The live stream is keyed by it, so
   * this is what lets a far-from-the-money position (which has no stored tick series) be marked from the live book.
   */
  async providerSymbolFor(input: {
    underlyingSymbol: string;
    expiryDate: Date;
    strikePrice: number;
    optionType: "CE" | "PE";
  }): Promise<string | null> {
    const result = await this.pool.query(`
      SELECT provider_symbol
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1 AND expiry_date = $2::date AND strike_price = $3 AND option_type = $4
      ORDER BY observed_at DESC
      LIMIT 1
    `, [input.underlyingSymbol, input.expiryDate.toISOString().slice(0, 10), input.strikePrice, input.optionType]);
    const symbol = result.rows[0]?.provider_symbol;
    return typeof symbol === "string" && symbol.length > 0 ? symbol : null;
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
  async latestExpiryCalendar(
    underlyingSymbol: string,
    asOf = new Date(),
  ): Promise<OptionExpiryCalendar | null> {
    const result = await this.pool.query(`
      SELECT provider, observed_at, expiry_date, expiry_kind
      FROM option_expiry_calendar
      WHERE underlying_symbol = $1
        AND observed_at = (
          SELECT max(observed_at) FROM option_expiry_calendar
          WHERE underlying_symbol = $1 AND observed_at <= $2
        )
      ORDER BY expiry_date
    `, [underlyingSymbol, asOf]);
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
   * One chain per stored day (every strike of one expiry), for the IV percentile.
   *
   * Returns the *last* snapshot of each day. A percentile needs one value per day: intraday
   * snapshots are autocorrelated, so ranking against all of them would let two sessions look
   * like fifty independent samples.
   *
   * The expiry is the nearest one that is still at least one calendar date away
   * (`expiry_date > session_date`). Expiry-day contracts are excluded from the percentile base
   * (their IV is gamma/pin-dominated and not comparable with other tenors). The expiry still
   * rotates from day to day, so the caller must tag each day with its days-to-expiry and rank
   * only within a tenor bucket -- see `iv-percentile-by-tenor.ts`. All strikes are returned,
   * not just the ATM ones, because the caller needs two-sided pairs across strikes to recover
   * the put-call-parity forward on the same basis as the live reading.
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
      -- Nearest expiry that is not the session's own expiry day. The tenor still differs from
      -- day to day, so the caller buckets by days-to-expiry rather than ranking across them.
      WHERE s.expiry_date = (
        SELECT min(expiry_date) FROM option_chain_snapshots inner_s
        WHERE inner_s.underlying_symbol = $1 AND inner_s.observed_at = r.observed_at
          AND inner_s.expiry_date > r.session_date
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
    asOf?: Date;
  }): Promise<OptionChainSnapshot | null> {
    const latest = await this.pool.query(`
      SELECT max(observed_at) AS observed_at
      FROM option_chain_snapshots
      WHERE underlying_symbol = $1
        AND ($2::date IS NULL OR expiry_date = $2::date)
        AND observed_at <= $3
    `, [input.underlyingSymbol, input.expiryDate ?? null, input.asOf ?? new Date()]);
    const observedAt = latest.rows[0]?.observed_at as Date | null | undefined;
    if (!observedAt) return null;

    const result = await this.pool.query(`
      SELECT provider, expiry_date, expiry_kind, strike_price, option_type, provider_symbol,
             provider_token, last_price, bid, ask, volume, open_interest,
             previous_open_interest, open_interest_change, underlying_value,
             vendor_delta, vendor_gamma, vendor_theta, vendor_vega, vendor_iv_percent
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
      vendorGreeks: vendorGreeksFromRow(row),
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

  /**
   * Every stored contract row for one underlying and one expiry inside one IST session day, in time
   * order, for rebuilding open interest over the session (`oi-history.ts`).
   *
   * The session is bounded as a half-open range on `observed_at` rather than by casting each row to an
   * IST date: the range can use the `(underlying_symbol, expiry_date, observed_at)` index, the cast
   * cannot. `$2::date::timestamp AT TIME ZONE 'Asia/Kolkata'` is IST midnight as a `timestamptz`.
   *
   * With no `expiryDate` the nearest expiry on or after the session day that has rows in it is used,
   * and the one chosen is returned so the caller never has to guess which expiry it is looking at.
   * Dates cross the driver as `DATE` columns, so they go through `fromDateColumn`: node-pg reads a
   * `DATE` as local midnight and a bare `toISOString()` is a day early on an IST host.
   *
   * Bounded by construction: one underlying, one expiry, one day -- roughly 30 snapshots of 62 rows.
   */
  async oiHistoryRows(input: {
    underlyingSymbol: string;
    sessionDate: string;
    expiryDate?: string | null;
  }): Promise<{
    expiryDate: string | null;
    rows: Array<{
      observedAt: Date;
      strikePrice: number;
      optionType: OptionType;
      openInterest: number | null;
      previousOpenInterest: number | null;
      underlyingValue: number | null;
    }>;
  }> {
    const result = await this.pool.query(`
      WITH bounds AS (
        SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS lo
      ),
      chosen AS (
        SELECT COALESCE(
          $3::date,
          (SELECT min(s.expiry_date)
             FROM option_chain_snapshots s, bounds b
            WHERE s.underlying_symbol = $1
              AND s.observed_at >= b.lo AND s.observed_at < b.lo + interval '1 day'
              AND s.expiry_date >= $2::date)
        ) AS expiry_date
      )
      SELECT s.observed_at, s.expiry_date, s.strike_price, s.option_type,
             s.open_interest, s.previous_open_interest, s.underlying_value
        FROM option_chain_snapshots s, bounds b, chosen c
       WHERE s.underlying_symbol = $1
         AND s.expiry_date = c.expiry_date
         AND s.observed_at >= b.lo AND s.observed_at < b.lo + interval '1 day'
       ORDER BY s.observed_at, s.strike_price, s.option_type
    `, [input.underlyingSymbol, input.sessionDate, input.expiryDate ?? null]);

    return {
      expiryDate: result.rows.length === 0
        ? (input.expiryDate ?? null)
        : toDateKey(fromDateColumn(result.rows[0].expiry_date)),
      rows: result.rows.map((row) => ({
        observedAt: row.observed_at as Date,
        strikePrice: Number(row.strike_price),
        optionType: String(row.option_type) as OptionType,
        openInterest: toNumberOrNull(row.open_interest),
        previousOpenInterest: toNumberOrNull(row.previous_open_interest),
        underlyingValue: toNumberOrNull(row.underlying_value),
      })),
    };
  }

  /**
   * IST session days that have stored snapshots, newest first, with how many collection runs each
   * holds -- the date picker's source. The count is the honest signal that a session is partial or ran
   * on a holiday (the collection cron has no holiday calendar), so the caller shows it instead of
   * hiding thin sessions.
   *
   * Counted per distinct *minute*, not per distinct `observed_at`: when two expiries are live, one
   * run stamps each expiry's rows about 0.35s apart, so counting timestamps reported 56 "snapshots"
   * for a day of 28 runs. The cron fires at most once a minute, so a minute is one run.
   */
  async oiHistorySessions(input: { underlyingSymbol: string; limit?: number }): Promise<Array<{
    sessionDate: string;
    snapshotCount: number;
    firstObservedAt: Date;
    lastObservedAt: Date;
  }>> {
    const limit = Math.min(60, Math.max(1, Math.floor(input.limit ?? 30)));
    const result = await this.pool.query(`
      SELECT (observed_at AT TIME ZONE 'Asia/Kolkata')::date AS session_date,
             count(DISTINCT date_trunc('minute', observed_at)) AS snapshot_count,
             min(observed_at) AS first_observed_at,
             max(observed_at) AS last_observed_at
        FROM option_chain_snapshots
       WHERE underlying_symbol = $1
         AND observed_at > now() - interval '120 days'
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT $2
    `, [input.underlyingSymbol, limit]);
    return result.rows.map((row) => ({
      sessionDate: toDateKey(fromDateColumn(row.session_date)),
      snapshotCount: Number(row.snapshot_count),
      firstObservedAt: row.first_observed_at as Date,
      lastObservedAt: row.last_observed_at as Date,
    }));
  }

  /**
   * Per IST weekday, how much of the regular session (09:15-15:30 IST) the stored snapshots cover, for the data-coverage view.
   *
   * Counted per distinct *minute*, as `oiHistorySessions` does, so two expiries stamped 0.35 s apart are one run. The
   * pre-open (09:11, previous-close carryover) and post-close snapshots are not in `inSessionMinutes`; they are counted apart so
   * the view can say they exist and were set aside. `firstAt` and `lastAt` are of the in-session snapshots.
   */
  async snapshotCoverageDays(input: { underlyingSymbol: string; fromDate: string; toDate: string }): Promise<Array<{
    date: string;
    inSessionMinutes: number;
    preOpenMinutes: number;
    postCloseMinutes: number;
    firstAt: Date | null;
    lastAt: Date | null;
    expiries: number;
  }>> {
    const local = "(observed_at AT TIME ZONE 'Asia/Kolkata')";
    const result = await this.pool.query(`
      SELECT to_char(${local}::date, 'YYYY-MM-DD') AS day,
             count(DISTINCT date_trunc('minute', observed_at))
               FILTER (WHERE ${local}::time >= TIME '09:15' AND ${local}::time < TIME '15:30') AS in_session,
             count(DISTINCT date_trunc('minute', observed_at)) FILTER (WHERE ${local}::time < TIME '09:15') AS pre_open,
             count(DISTINCT date_trunc('minute', observed_at)) FILTER (WHERE ${local}::time >= TIME '15:30') AS post_close,
             min(observed_at) FILTER (WHERE ${local}::time >= TIME '09:15' AND ${local}::time < TIME '15:30') AS first_at,
             max(observed_at) FILTER (WHERE ${local}::time >= TIME '09:15' AND ${local}::time < TIME '15:30') AS last_at,
             count(DISTINCT expiry_date) AS expiries
        FROM option_chain_snapshots
       WHERE underlying_symbol = $1
         AND observed_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND observed_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND EXTRACT(ISODOW FROM ${local}) < 6
       GROUP BY 1
       ORDER BY 1 DESC
    `, [input.underlyingSymbol, input.fromDate, input.toDate]);
    return result.rows.map((row) => ({
      date: String(row.day),
      inSessionMinutes: Number(row.in_session),
      preOpenMinutes: Number(row.pre_open),
      postCloseMinutes: Number(row.post_close),
      firstAt: (row.first_at as Date | null) ?? null,
      lastAt: (row.last_at as Date | null) ?? null,
      expiries: Number(row.expiries),
    }));
  }

  /** When the newest snapshot of an underlying was received, or null when none is stored. One index probe. */
  async latestObservedAt(underlyingSymbol: string): Promise<Date | null> {
    const result = await this.pool.query(
      "SELECT max(observed_at) AS observed_at FROM option_chain_snapshots WHERE underlying_symbol = $1",
      [underlyingSymbol],
    );
    return (result.rows[0]?.observed_at as Date | null | undefined) ?? null;
  }

  /**
   * The newest `count` stored snapshots of one expiry (each a whole chain at one `observed_at`), for the quote-staleness view.
   *
   * With no `expiryDate` the nearest expiry present in the newest snapshot is used, which is the one the chain page opens on, and
   * the one chosen is returned. Read as two small statements, the distinct times first and then only their rows, so the
   * `(underlying_symbol, expiry_date, observed_at)` index serves both. Bounded: `count` snapshots of about 62 rows.
   */
  async recentQuoteSnapshots(input: {
    underlyingSymbol: string;
    expiryDate?: string | null;
    asOf: Date;
    count: number;
  }): Promise<{
    expiryDate: string | null;
    snapshots: Array<{ observedAt: Date; quotes: Array<{ strike: number; side: "CE" | "PE"; bid: number | null; ask: number | null }> }>;
  }> {
    let expiry = input.expiryDate ?? null;
    if (expiry === null) {
      const nearest = await this.pool.query(`
        SELECT expiry_date::text AS expiry_date
          FROM option_chain_snapshots
         WHERE underlying_symbol = $1
           AND observed_at = (SELECT max(observed_at) FROM option_chain_snapshots WHERE underlying_symbol = $1 AND observed_at <= $2)
         ORDER BY expiry_date
         LIMIT 1
      `, [input.underlyingSymbol, input.asOf]);
      expiry = (nearest.rows[0]?.expiry_date as string | undefined) ?? null;
    }
    if (expiry === null) return { expiryDate: null, snapshots: [] };

    const times = await this.pool.query(`
      SELECT DISTINCT observed_at
        FROM option_chain_snapshots
       WHERE underlying_symbol = $1 AND expiry_date = $2::date AND observed_at <= $3
       ORDER BY observed_at DESC
       LIMIT $4
    `, [input.underlyingSymbol, expiry, input.asOf, input.count]);
    const observed = times.rows.map((row) => row.observed_at as Date);
    if (observed.length === 0) return { expiryDate: expiry, snapshots: [] };

    const rows = await this.pool.query(`
      SELECT observed_at, strike_price, option_type, bid, ask
        FROM option_chain_snapshots
       WHERE underlying_symbol = $1 AND expiry_date = $2::date AND observed_at = ANY($3::timestamptz[])
       ORDER BY observed_at DESC, strike_price, option_type
    `, [input.underlyingSymbol, expiry, observed]);

    const byTime = new Map<number, Array<{ strike: number; side: "CE" | "PE"; bid: number | null; ask: number | null }>>();
    for (const row of rows.rows) {
      const key = (row.observed_at as Date).getTime();
      const list = byTime.get(key) ?? [];
      list.push({ strike: Number(row.strike_price), side: String(row.option_type) as "CE" | "PE", bid: toNumberOrNull(row.bid), ask: toNumberOrNull(row.ask) });
      byTime.set(key, list);
    }
    return {
      expiryDate: expiry,
      snapshots: observed.map((observedAt) => ({ observedAt, quotes: byTime.get(observedAt.getTime()) ?? [] })),
    };
  }
}
