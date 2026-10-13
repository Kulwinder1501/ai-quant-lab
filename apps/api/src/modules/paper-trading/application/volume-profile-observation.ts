import {
  VOLUME_PROFILE_ALGORITHM_VERSION,
  buildFixedRowVolumeProfile,
  describeEntryAgainstProfile,
  type ProfileLevel,
  type TradeDirection,
} from "../../market-data/domain/fixed-row-volume-profile.js";

/**
 * A log-only observation: where does this entry sit against the prior session's volume profile?
 *
 * ## Why it exists, and why it only observes
 *
 * The first FRVP study could not reach a verdict (7 sessions, a one-day test, and a node detector
 * that found 0.29 low-volume nodes per session), and its profile placed the POC on single stray
 * bars. This records, for every AutoBot trade the bot opens, what a profile built properly says about
 * that entry, so the question can be answered from live entries instead of a handful of sessions.
 * Nothing about the entry changes: no veto, no resize, no delay.
 *
 * The stamp is appended to `paper_trades.notes` as `FRVP_OBS {json}` -- last, so it parses with
 * `FRVP_OBS (\{.*\})$` -- which needs no migration and joins each entry to its outcome for free. The
 * profile rows themselves are not stored: the session date and contract are in the stamp and the
 * candles are in the database, so any later definition of a node can be recomputed from them.
 *
 * The definition, the one primary hypothesis and when it may be judged are frozen in
 * `docs/2026-10-13-frvp-rows-observation-protocol.md`.
 *
 * ## What the profile is
 *
 * The prior completed IST session, from the front index future with the most volume that day, one
 * 1-minute futures bar at a time: the futures bar's volume is placed on the same minute's *index*
 * high-low range, in 48 rows. See `fixed-row-volume-profile.ts` for why that, not a basis mapping.
 *
 * ## What this must never do
 *
 * Block, resize or delay an entry. A lookup that throws returns null and the trade opens unstamped,
 * the same contract as `observeOppositeSignal`. A lookup that works but finds no profile still
 * stamps, with a status, so "unavailable" is told apart from "never looked" and coverage is
 * measurable.
 */
export const VOLUME_PROFILE_OBSERVATION_CODE = "FRVP_OBS";

/** A session with fewer paired minutes than this is a partial day and is not profiled. */
export const MINIMUM_PROFILE_MINUTES = 300;
const SESSION_LOOKBACK_DAYS = 10;
const INDIA_OFFSET_MS = 5.5 * 3_600_000;

export interface ProfileObservationDatabase {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface VolumeProfileObservationInput {
  database: ProfileObservationDatabase;
  /** The index the trade is on: `NIFTY50` or `BANKNIFTY`; also the futures' `underlying_symbol`. */
  underlyingSymbol: string;
  tradeIdeaId: string;
  /** Direction of the underlying the trade is betting on, not the option's side. */
  direction: TradeDirection;
  now: Date;
}

type ObservationStatus = "OK" | "NO_ENTRY_PRICE" | "NO_PRIOR_SESSION_FUTURES" | "THIN_SESSION" | "PROFILE_NOT_BUILT";

function indiaDate(instant: Date): string {
  return new Date(instant.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function levelTuple(level: ProfileLevel | null): [number, number] | null {
  return level === null ? null : [round1(level.level), round1(level.distance)];
}

function stamp(body: Record<string, unknown>): string {
  return ` Observed (log-only, no effect on entry): ${VOLUME_PROFILE_OBSERVATION_CODE} ${JSON.stringify({
    v: VOLUME_PROFILE_ALGORITHM_VERSION,
    ...body,
  })}`;
}

function unavailable(status: ObservationStatus, extra: Record<string, unknown> = {}): string {
  return stamp({ st: status, ...extra });
}

/**
 * Returns the note fragment to append to the trade's notes, or null when the lookup itself failed.
 */
export async function observeVolumeProfile(input: VolumeProfileObservationInput): Promise<string | null> {
  try {
    const today = indiaDate(input.now);
    const startOfToday = new Date(`${today}T00:00:00+05:30`);
    const since = new Date(startOfToday.getTime() - SESSION_LOOKBACK_DAYS * 86_400_000);

    const ideaResult = await input.database.query(
      "SELECT entry_price::float8 AS entry_price FROM trade_ideas WHERE id = $1",
      [input.tradeIdeaId],
    );
    const entry = Number(ideaResult.rows[0]?.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) return unavailable("NO_ENTRY_PRICE");

    const sessionResult = await input.database.query(
      `SELECT f.id::text AS instrument_id,
              f.symbol AS symbol,
              (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS session_date,
              SUM(c.volume)::float8 AS volume,
              COUNT(*)::int AS bars
         FROM instruments f
         JOIN candles c ON c.instrument_id = f.id AND c.timeframe = '1m' AND c.is_complete
        WHERE f.instrument_type = 'FUTURE'
          AND f.underlying_symbol = $1
          AND f.expiry_date >= $2::date
          AND c.open_time >= $3
          AND c.open_time < $4
        GROUP BY f.id, f.symbol, (c.open_time AT TIME ZONE 'Asia/Kolkata')::date
       HAVING COUNT(*) >= ${MINIMUM_PROFILE_MINUTES}
        ORDER BY (c.open_time AT TIME ZONE 'Asia/Kolkata')::date DESC, SUM(c.volume) DESC
        LIMIT 1`,
      [input.underlyingSymbol, today, since, startOfToday],
    );
    const session = sessionResult.rows[0];
    if (!session) return unavailable("NO_PRIOR_SESSION_FUTURES", { e: round1(entry) });

    const instrumentId = String(session.instrument_id);
    const sessionDate = String(session.session_date);
    const contract = String(session.symbol);
    const futuresBars = Number(session.bars);

    const barResult = await input.database.query(
      `SELECT ic.high::float8 AS high, ic.low::float8 AS low, ic.close::float8 AS close, fc.volume::float8 AS volume
         FROM candles fc
         JOIN instruments ix ON ix.symbol = $2 AND ix.instrument_type = 'INDEX'
         JOIN candles ic ON ic.instrument_id = ix.id AND ic.timeframe = '1m' AND ic.is_complete
                        AND ic.open_time = fc.open_time
        WHERE fc.instrument_id = $1
          AND fc.timeframe = '1m'
          AND fc.is_complete
          AND (fc.open_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
        ORDER BY fc.open_time`,
      [instrumentId, input.underlyingSymbol, sessionDate],
    );
    const bars = barResult.rows.map((row) => ({
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }));
    const base = { sess: sessionDate, fut: contract, e: round1(entry) };
    if (bars.length < MINIMUM_PROFILE_MINUTES) return unavailable("THIN_SESSION", { ...base, n: bars.length });

    const profile = buildFixedRowVolumeProfile(bars);
    if (!profile) return unavailable("PROFILE_NOT_BUILT", base);

    const view = describeEntryAgainstProfile(profile, entry, input.direction);
    return stamp({
      st: "OK",
      ...base,
      cov: Math.round((bars.length / futuresBars) * 100) / 100,
      pos: view.position,
      poc: round1(view.poc),
      vah: round1(view.vah),
      val: round1(view.val),
      rw: round1(view.rowWidth),
      lvnA: levelTuple(view.lvnAhead),
      lvnB: levelTuple(view.lvnBehind),
      hvnA: levelTuple(view.hvnAhead),
      open: view.lvnBeforeHvn,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Volume-profile observation failed; the trade opens unstamped.",
      underlyingSymbol: input.underlyingSymbol,
      tradeIdeaId: input.tradeIdeaId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
