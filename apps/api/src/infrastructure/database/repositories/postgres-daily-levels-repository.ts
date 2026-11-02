import type { DatabaseQueryable } from "../database.js";
import type { DailyBar, DailyLevelsInstrument, LevelSheet, OiStrike } from "../../../modules/daily-levels/domain/levels.js";
import type { IntradayBar, ReactionSummary } from "../../../modules/daily-levels/domain/reaction-study.js";

/** The last option-chain observation before the open, for the nearest expiry that has not passed. */
export interface OiObservation {
  readonly strikes: readonly OiStrike[];
  readonly observedAt: string;
  readonly expiry: string;
}

export interface StoredLevelSheet {
  readonly version: number;
  readonly generatedAt: string;
  readonly sheet: LevelSheet;
}

export interface StoredStudy {
  readonly studyVersion: string;
  readonly computedAt: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly payload: StudyPayload;
}

export interface StudyPayload {
  readonly underlying: DailyLevelsInstrument;
  readonly sessionsUsed: number;
  readonly sessionsSkipped: number;
  readonly realLevelTouches: number;
  readonly parameters: Record<string, unknown>;
  readonly summaries: readonly ReactionSummary[];
  /** Real levels in confluence-2-or-more zones against confluence-1 zones: same statistic, no placebo. */
  readonly confluence: ReactionSummary | null;
}

/** How far back an option-chain observation may be and still stand for "the previous session". */
const OI_MAX_AGE_DAYS = 5;

/**
 * Reads and writes for the daily levels sheet. Dates are IST calendar dates as `YYYY-MM-DD` strings, converted in SQL so no JavaScript
 * time-zone arithmetic is involved.
 */
export class PostgresDailyLevelsRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /** Every completed daily bar, oldest first. */
  async dailyBars(underlying: DailyLevelsInstrument): Promise<DailyBar[]> {
    const result = await this.database.query<{ date: string; high: string; low: string; close: string }>(
      `SELECT to_char(c.open_time AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date, c.high, c.low, c.close
       FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.exchange = 'NSE' AND i.symbol = $1 AND c.timeframe = '1d' AND c.is_complete
       ORDER BY c.open_time`,
      [underlying],
    );
    return result.rows.map((row) => ({ date: row.date, high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
  }

  /** Regular-session 15-minute bars (09:15 to 15:15 open times) grouped by IST date, oldest first. */
  async sessionBars15m(underlying: DailyLevelsInstrument, fromDate: string, toDate: string): Promise<Map<string, IntradayBar[]>> {
    const result = await this.database.query<{ date: string; hhmm: string; open: string; high: string; low: string; close: string }>(
      `SELECT to_char(c.open_time AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date,
              to_char(c.open_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS hhmm,
              c.open, c.high, c.low, c.close
       FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.exchange = 'NSE' AND i.symbol = $1 AND c.timeframe = '15m' AND c.is_complete
         AND (c.open_time AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
       ORDER BY c.open_time`,
      [underlying, fromDate, toDate],
    );
    const sessions = new Map<string, IntradayBar[]>();
    for (const row of result.rows) {
      if (row.hhmm < "09:15" || row.hhmm > "15:15") continue;
      const bars = sessions.get(row.date) ?? [];
      bars.push({ open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) });
      sessions.set(row.date, bars);
    }
    return sessions;
  }

  /**
   * The option chain the sheet's open-interest walls come from: the nearest expiry that is on or after the session date among observations
   * from the last five days and strictly before 08:50 IST on the session date, and the latest such observation of that expiry.
   *
   * The expiry is chosen first, then its latest observation. The collector stores one expiry per snapshot and rolls to the next week
   * after the close of the day before expiry, so the last snapshot overall can belong to next week's expiry (seen 2026-11-02: the 11-03
   * weekly was last observed in-session, and the 15:53 snapshot already held 11-09). Taking the last snapshot would then show next week's
   * positioning on the very day the nearer expiry matters most.
   */
  async oiBeforeOpen(underlying: DailyLevelsInstrument, sessionDate: string): Promise<OiObservation | null> {
    const window = `underlying_symbol = $1
         AND observed_at < (($2::date + time '08:50') AT TIME ZONE 'Asia/Kolkata')
         AND observed_at >= (($2::date - $3::int + time '00:00') AT TIME ZONE 'Asia/Kolkata')`;
    const nearest = await this.database.query<{ expiry: string | null }>(
      `SELECT to_char(min(expiry_date), 'YYYY-MM-DD') AS expiry FROM option_chain_snapshots
       WHERE ${window} AND expiry_date >= $2::date`,
      [underlying, sessionDate, OI_MAX_AGE_DAYS],
    );
    const expiry = nearest.rows[0]?.expiry ?? null;
    if (expiry === null) return null;

    const latest = await this.database.query<{ observed_at: Date | null }>(
      `SELECT max(observed_at) AS observed_at FROM option_chain_snapshots
       WHERE ${window} AND expiry_date = $4::date`,
      [underlying, sessionDate, OI_MAX_AGE_DAYS, expiry],
    );
    const observedAt = latest.rows[0]?.observed_at ?? null;
    if (observedAt === null) return null;

    const rows = await this.database.query<{ strike: string; option_type: string; open_interest: string | null }>(
      `SELECT strike_price AS strike, option_type, open_interest FROM option_chain_snapshots
       WHERE underlying_symbol = $1 AND observed_at = $2 AND expiry_date = $3::date`,
      [underlying, observedAt, expiry],
    );
    const byStrike = new Map<number, { callOi: number; putOi: number }>();
    for (const row of rows.rows) {
      const strike = Number(row.strike);
      const entry = byStrike.get(strike) ?? { callOi: 0, putOi: 0 };
      const oi = row.open_interest === null ? 0 : Number(row.open_interest);
      if (row.option_type === "CE") entry.callOi = oi;
      else if (row.option_type === "PE") entry.putOi = oi;
      byStrike.set(strike, entry);
    }
    return {
      strikes: [...byStrike.entries()].map(([strike, oi]) => ({ strike, callOi: oi.callOi, putOi: oi.putOi })).sort((x, y) => x.strike - y.strike),
      observedAt: observedAt.toISOString(),
      expiry,
    };
  }

  /** The NSE holiday name for a date, or null on a trading day. */
  async holidayName(date: string): Promise<string | null> {
    const result = await this.database.query<{ name: string }>("SELECT name FROM nse_holidays WHERE holiday_date = $1::date", [date]);
    return result.rows[0]?.name ?? null;
  }

  async hasSheet(underlying: DailyLevelsInstrument, sessionDate: string): Promise<boolean> {
    const result = await this.database.query(
      "SELECT 1 FROM daily_level_sheets WHERE underlying_symbol = $1 AND session_date = $2::date LIMIT 1",
      [underlying, sessionDate],
    );
    return result.rows.length > 0;
  }

  /** Stores a sheet as the next version for its session and returns the version. Never overwrites. */
  async saveSheet(sheet: LevelSheet): Promise<{ version: number; generatedAt: string }> {
    const result = await this.database.query<{ version: number; generated_at: Date }>(
      `INSERT INTO daily_level_sheets (underlying_symbol, session_date, version, reference_date, reference_price, payload)
       SELECT $1, $2::date, COALESCE(MAX(version), 0) + 1, $3::date, $4, $5::jsonb
       FROM daily_level_sheets WHERE underlying_symbol = $1 AND session_date = $2::date
       RETURNING version, generated_at`,
      [sheet.underlying, sheet.sessionDate, sheet.referenceDate, sheet.referencePrice, JSON.stringify(sheet)],
    );
    return { version: result.rows[0].version, generatedAt: result.rows[0].generated_at.toISOString() };
  }

  /** The highest version for the session, or for the most recent session when `sessionDate` is null. */
  async latestSheet(underlying: DailyLevelsInstrument, sessionDate: string | null): Promise<StoredLevelSheet | null> {
    const result = await this.database.query<{ version: number; generated_at: Date; payload: LevelSheet }>(
      `SELECT version, generated_at, payload FROM daily_level_sheets
       WHERE underlying_symbol = $1 AND ($2::date IS NULL OR session_date = $2::date)
       ORDER BY session_date DESC, version DESC LIMIT 1`,
      [underlying, sessionDate],
    );
    const row = result.rows[0];
    return row ? { version: row.version, generatedAt: row.generated_at.toISOString(), sheet: row.payload } : null;
  }

  async saveStudy(studyVersion: string, windowFrom: string, windowTo: string, payload: StudyPayload): Promise<void> {
    await this.database.query(
      `INSERT INTO daily_level_study_results (study_version, underlying_symbol, window_from, window_to, payload)
       VALUES ($1, $2, $3::date, $4::date, $5::jsonb)`,
      [studyVersion, payload.underlying, windowFrom, windowTo, JSON.stringify(payload)],
    );
  }

  async latestStudy(underlying: DailyLevelsInstrument): Promise<StoredStudy | null> {
    const result = await this.database.query<{ study_version: string; computed_at: Date; window_from: string; window_to: string; payload: StudyPayload }>(
      `SELECT study_version, computed_at, to_char(window_from, 'YYYY-MM-DD') AS window_from, to_char(window_to, 'YYYY-MM-DD') AS window_to, payload
       FROM daily_level_study_results WHERE underlying_symbol = $1 ORDER BY computed_at DESC LIMIT 1`,
      [underlying],
    );
    const row = result.rows[0];
    return row
      ? { studyVersion: row.study_version, computedAt: row.computed_at.toISOString(), windowFrom: row.window_from, windowTo: row.window_to, payload: row.payload }
      : null;
  }
}
