import type { DatabasePool } from "../database.js";
import type { FuturesBar } from "../../../modules/market-data/domain/session-volume-profile.js";

/**
 * Reads stored 1-minute bars of an index future (`candles`, timeframe `1m`), for the volume profile.
 *
 * The contract is addressed by its lab symbol (`BANKNIFTY26OCTFUT`, no exchange prefix). Only complete bars are read, so a
 * minute still forming is never part of a profile. The caller resolves which contract was the front month on the day:
 * a bar of the next month is a different, thinner market (September 2026's October contract traded 13-70k units a day
 * against 400-700k for the front month) and must never stand in for it.
 */
export class PostgresFuturesBarRepository {
  constructor(private readonly database: DatabasePool) {}

  /** Complete 1-minute bars with `open_time` in `[from, to)`, oldest first. */
  async bars(input: { symbol: string; from: Date; to: Date }): Promise<FuturesBar[]> {
    const result = await this.database.query<{
      open_time: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>(
      `SELECT c.open_time, c.open, c.high, c.low, c.close, c.volume
         FROM candles c
         JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1
          AND c.timeframe = '1m'
          AND c.is_complete
          AND c.open_time >= $2 AND c.open_time < $3
        ORDER BY c.open_time ASC`,
      [input.symbol.toUpperCase(), input.from, input.to],
    );
    // NUMERIC arrives as a string from node-postgres.
    return result.rows.map((row) => ({
      openTime: row.open_time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }));
  }

  /**
   * The weekdays from `fromDate` to `toDate` inclusive (IST calendar dates) on which this contract has complete bars
   * opening 09:15-15:30 IST, newest first, with how many bars, how many carried volume, and when the first and last opened.
   * One indexed range over a single instrument's bars (about 14,000 rows a contract), grouped by IST day.
   */
  async sessionDays(input: { symbol: string; fromDate: string; toDate: string }): Promise<Array<{
    date: string;
    bars: number;
    barsWithVolume: number;
    firstAt: Date;
    lastAt: Date;
  }>> {
    const local = "(c.open_time AT TIME ZONE 'Asia/Kolkata')";
    const result = await this.database.query<{
      day: string;
      bars: string;
      bars_with_volume: string;
      first_at: Date;
      last_at: Date;
    }>(
      `SELECT to_char(${local}, 'YYYY-MM-DD') AS day,
              COUNT(*) AS bars,
              COUNT(*) FILTER (WHERE c.volume > 0) AS bars_with_volume,
              MIN(c.open_time) AS first_at,
              MAX(c.open_time) AS last_at
         FROM candles c
         JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1
          AND c.timeframe = '1m'
          AND c.is_complete
          AND c.open_time >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND c.open_time <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND ${local}::time >= TIME '09:15' AND ${local}::time < TIME '15:30'
          AND EXTRACT(ISODOW FROM ${local}) < 6
        GROUP BY 1
        ORDER BY 1 DESC`,
      [input.symbol.toUpperCase(), input.fromDate, input.toDate],
    );
    return result.rows.map((row) => ({
      date: row.day,
      bars: Number(row.bars),
      barsWithVolume: Number(row.bars_with_volume),
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));
  }
}
