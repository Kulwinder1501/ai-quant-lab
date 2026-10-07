import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import { CompletedCandleImmutableError, type CandleRepository } from "../domain/candle.js";
import { aggregateOhlcBars, type TimestampedOhlc } from "../domain/synthetic-dxy.js";

interface CandleRow {
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
}

async function loadOneMinuteSeries(
  database: DatabaseQueryable,
  instrumentId: string,
  from: Date,
  to: Date,
): Promise<TimestampedOhlc[]> {
  const result = await database.query<CandleRow>(
    `SELECT open_time, close_time, open, high, low, close
     FROM candles
     WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
       AND open_time >= $2 AND open_time < $3
     ORDER BY open_time ASC`,
    [instrumentId, from, to],
  );
  return result.rows.map((row) => ({
    openTime: row.open_time,
    closeTime: row.close_time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

export interface DeriveHigherTimeframeCandlesResult {
  readonly timeframe: string;
  readonly barsWritten: number;
  /** Buckets whose close already carries a settled value from a different source (almost always
   * a provider-fetched bar from before this instrument switched to local derivation -- see the
   * module docstring's "not byte-identical" note). Not an error; the earlier writer wins. */
  readonly barsAlreadySettledElsewhere: number;
}

/**
 * Rolls an instrument's own already-collected 1m candles up into longer timeframes locally,
 * instead of fetching each one separately from the provider.
 *
 * Built for XAU_USD: Twelve Data charges a separate `/time_series` credit per timeframe, and
 * `XAU_CANDLE_COLLECTION` was fetching 1m, 5m, AND 15m independently every 5 minutes -- 3 of the
 * job's 9 calls per tick for one instrument alone, when 5m and 15m are otherwise derivable from
 * the 1m bars the same tick already fetched. Reuses `aggregateOhlcBars`, the same rollup
 * `compute-synthetic-dxy-candles.ts` uses -- that function already refuses to emit a partial
 * bucket (a window short of its full count of source minutes), which is exactly the property
 * that makes a locally-rolled bar as trustworthy as one fetched directly: it is never published
 * until every minute inside it has actually arrived.
 *
 * ## Not byte-identical to Twelve Data's own native bar -- confirmed, not assumed
 *
 * Verified 2026-10-07 against a real native XAU_USD 5m bar already in storage: open/high/low
 * matched a from-scratch 1m rollup exactly, but `close` did not -- Twelve Data's own 5m close for
 * a [T, T+5) bucket matched the 4th 1-minute bar's close, not the 5th (last) one. The gap was
 * tiny (~$0.13 on a ~$4,143 instrument) but real, and `PostgresCandleRepository.upsert`'s
 * immutability guard correctly refused to silently overwrite the already-settled native value
 * with a conflicting derived one -- see `barsAlreadySettledElsewhere` below for how that case is
 * handled rather than treated as a failure. This is read as a genuine inter-timeframe quirk on
 * the provider's side (their 1m and 5m feeds are evidently not perfectly reconciled), not a bug
 * in this aggregation -- worth knowing before trusting a derived bar's close to the cent, though
 * the discrepancy is immaterial at the scale this strategy trades.
 *
 * `volume` is written as "0" unconditionally. XAU_USD (like every Twelve Data FX/metals series)
 * carries no real consolidated volume at 1m either -- see `twelvedata-quote-client.ts`'s own
 * docstring -- so there is nothing to aggregate; this only has to not invent a number.
 *
 * Not DXY-specific despite reusing its aggregation helper: this reads and writes ONE instrument's
 * own series, carrying the SAME `source` the 1m bars were collected under (not a synthetic one),
 * so `candles_series_provenance_fkey` is satisfied without a new provenance declaration.
 */
export async function deriveHigherTimeframeCandles(
  database: DatabaseQueryable,
  candleRepository: CandleRepository,
  input: {
    instrumentId: string;
    source: string;
    from: Date;
    to: Date;
    /** e.g. [5, 15] for 5m and 15m. */
    bucketMinutesList: readonly number[];
  },
): Promise<DeriveHigherTimeframeCandlesResult[]> {
  const oneMinuteBars = await loadOneMinuteSeries(database, input.instrumentId, input.from, input.to);

  const results: DeriveHigherTimeframeCandlesResult[] = [];
  for (const bucketMinutes of input.bucketMinutesList) {
    const timeframe = `${bucketMinutes}m`;
    const bars = aggregateOhlcBars(oneMinuteBars, bucketMinutes);
    let written = 0;
    let alreadySettledElsewhere = 0;
    for (const bar of bars) {
      try {
        await candleRepository.upsert({
          instrumentId: input.instrumentId,
          timeframe,
          openTime: bar.openTime,
          closeTime: bar.closeTime,
          open: bar.open.toFixed(6),
          high: bar.high.toFixed(6),
          low: bar.low.toFixed(6),
          close: bar.close.toFixed(6),
          volume: "0",
          isComplete: true,
          source: input.source,
          sourceMetadata: { derivedFrom: "1m", aggregationRule: "local-rollup-v1" },
        });
        written += 1;
      } catch (error) {
        // Same reasoning CompletedCandleImmutableError's own docstring gives for the live
        // collector racing the historical importer: a refusal here only means some other writer
        // (almost always a provider-fetched bar from before this instrument moved to local
        // derivation) already settled this exact bucket. Yield to it rather than die -- the next
        // bucket is unaffected, and there is nothing to retry.
        if (error instanceof CompletedCandleImmutableError) {
          alreadySettledElsewhere += 1;
          continue;
        }
        throw error;
      }
    }
    results.push({ timeframe, barsWritten: written, barsAlreadySettledElsewhere: alreadySettledElsewhere });
  }
  return results;
}
