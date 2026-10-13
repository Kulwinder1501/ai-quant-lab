import {
  VOLUME_PROFILE_ALGORITHM_VERSION,
  buildFixedRowVolumeProfile,
  classifyProfileShape,
  SHAPE_STABILITY_ROWS,
  describeEntryAgainstProfile,
  type ProfileBar,
  type ProfileLevel,
  type TradeDirection,
} from "../../market-data/domain/fixed-row-volume-profile.js";

/**
 * A log-only observation: where does this entry sit against the volume profile, and what shape is it?
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
 * The definition, the hypotheses and when they may be judged are frozen in
 * `docs/2026-10-13-frvp-rows-observation-protocol.md`.
 *
 * ## Two profiles, the way a trader draws them
 *
 * - `d1`: the **prior completed session**, day high to day low -- the levels the market arrives at.
 * - `d0`: **today so far**, from the open to the last completed minute -- what is forming now,
 *   rebuilt at every entry from bars that had already closed.
 *
 * Each carries its own status, level read-out and shape (P, b, D, B). Volume is the front index
 * future's, placed on the same minute's index range; see `fixed-row-volume-profile.ts`. Index volume
 * is never substituted: measured over 16 session-profiles it agreed with futures volume on the shape
 * only 7 times (minute correlation 0.38).
 *
 * `d0` needs today's futures bars in the database *during* the session. They come from
 * `INDEX_FUTURES_INTRADAY`; where that source delivers nothing the block says `NO_TODAY_FUTURES`
 * rather than guessing, which also tells us whether the source works at all.
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
/** Today's profile is not read before this many paired minutes: a shape on a few bars is noise. */
export const MINIMUM_TODAY_MINUTES = 30;
const SESSION_LOOKBACK_DAYS = 10;
const INDIA_OFFSET_MS = 5.5 * 3_600_000;
const MINUTE_MS = 60_000;

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

function indiaDate(instant: Date): string {
  return new Date(instant.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function indiaClock(instant: Date): string {
  return new Date(instant.getTime() + INDIA_OFFSET_MS).toISOString().slice(11, 16);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

type BlockStatus = "OK" | "THIN_SESSION" | "PROFILE_NOT_BUILT" | "NO_PRIOR_SESSION_FUTURES" | "NO_TODAY_FUTURES" | "TOO_EARLY";

/** One profile read against the entry: status, shape and where the entry sits. */
function readBlock(
  bars: readonly ProfileBar[],
  entry: number,
  direction: TradeDirection,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const profile = buildFixedRowVolumeProfile(bars);
  if (!profile) return { st: "PROFILE_NOT_BUILT" satisfies BlockStatus, ...extra };
  const view = describeEntryAgainstProfile(profile, entry, direction);
  const shape = classifyProfileShape(profile);
  // A shape that changes when the row count does is not a stable reading of the profile, so say whether it held.
  const stable = SHAPE_STABILITY_ROWS.every((rows) => {
    const other = buildFixedRowVolumeProfile(bars, rows);
    return other !== null && classifyProfileShape(other).shape === shape.shape;
  });
  return {
    st: "OK" satisfies BlockStatus,
    ...extra,
    sh: shape.shape,
    stb: stable,
    pp: round2(shape.pocPosition),
    cp: round2(shape.centroidPosition),
    pos: view.position,
    poc: round1(view.poc),
    vah: round1(view.vah),
    val: round1(view.val),
    hi: round1(profile.high),
    lo: round1(profile.low),
    rw: round1(view.rowWidth),
    lvnA: levelTuple(view.lvnAhead),
    lvnB: levelTuple(view.lvnBehind),
    hvnA: levelTuple(view.hvnAhead),
    open: view.lvnBeforeHvn,
  };
}

function toBars(rows: ReadonlyArray<Record<string, unknown>>): ProfileBar[] {
  return rows.map((row) => ({
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
}

/**
 * Returns the note fragment to append to the trade's notes, or null when the lookup itself failed.
 */
export async function observeVolumeProfile(input: VolumeProfileObservationInput): Promise<string | null> {
  try {
    const today = indiaDate(input.now);
    const startOfToday = new Date(`${today}T00:00:00+05:30`);
    const since = new Date(startOfToday.getTime() - SESSION_LOOKBACK_DAYS * 86_400_000);
    // Only minutes that had closed by now: the bar still forming is not part of what the market has done.
    const completedBefore = new Date(Math.floor(input.now.getTime() / MINUTE_MS) * MINUTE_MS);

    const ideaResult = await input.database.query(
      "SELECT entry_price::float8 AS entry_price FROM trade_ideas WHERE id = $1",
      [input.tradeIdeaId],
    );
    const entry = Number(ideaResult.rows[0]?.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) return stamp({ st: "NO_ENTRY_PRICE" });

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
    if (!session) {
      return stamp({
        e: round1(entry),
        d1: { st: "NO_PRIOR_SESSION_FUTURES" satisfies BlockStatus },
        d0: { st: "NO_PRIOR_SESSION_FUTURES" satisfies BlockStatus },
      });
    }

    const instrumentId = String(session.instrument_id);
    const sessionDate = String(session.session_date);
    const contract = String(session.symbol);
    const futuresBars = Number(session.bars);

    // One read serves both profiles: a day's futures minutes joined to the same minutes of the index.
    const readPairedBars = async (date: string, before: Date | null) => {
      const result = await input.database.query(
        `SELECT ic.high::float8 AS high, ic.low::float8 AS low, ic.close::float8 AS close, fc.volume::float8 AS volume,
                fc.open_time AS open_time
           FROM candles fc
           JOIN instruments ix ON ix.symbol = $2 AND ix.instrument_type = 'INDEX'
           JOIN candles ic ON ic.instrument_id = ix.id AND ic.timeframe = '1m' AND ic.is_complete
                          AND ic.open_time = fc.open_time
          WHERE fc.instrument_id = $1
            AND fc.timeframe = '1m'
            AND fc.is_complete
            AND (fc.open_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
            AND ($4::timestamptz IS NULL OR fc.open_time < $4::timestamptz)
          ORDER BY fc.open_time`,
        [instrumentId, input.underlyingSymbol, date, before],
      );
      const last = result.rows[result.rows.length - 1]?.open_time;
      return { bars: toBars(result.rows), lastOpen: last ? new Date(last as string | Date) : null };
    };

    const { bars: priorBars } = await readPairedBars(sessionDate, null);
    const d1 = priorBars.length < MINIMUM_PROFILE_MINUTES
      ? { st: "THIN_SESSION" satisfies BlockStatus, sess: sessionDate, n: priorBars.length }
      : readBlock(priorBars, entry, input.direction, {
        sess: sessionDate,
        n: priorBars.length,
        cov: round2(priorBars.length / futuresBars),
      });

    const { bars: todayBars, lastOpen } = await readPairedBars(today, completedBefore);
    const d0 = todayBars.length === 0
      ? { st: "NO_TODAY_FUTURES" satisfies BlockStatus }
      : todayBars.length < MINIMUM_TODAY_MINUTES
        ? { st: "TOO_EARLY" satisfies BlockStatus, n: todayBars.length }
        // `asof` is the open time of the last minute actually used, which can trail the clock: the futures
        // bars arrive from a poll, not a stream.
        : readBlock(todayBars, entry, input.direction, {
          n: todayBars.length,
          ...(lastOpen ? { asof: indiaClock(lastOpen) } : {}),
        });

    return stamp({ e: round1(entry), fut: contract, d1, d0 });
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
